/**
 * 采集网关核心：从单一拉流源（MJPEG / RTSP 等 ffmpeg 可读地址）同时取出
 * 视频帧与音频流，经回调推送给上层。
 *
 * 架构：用两个独立的 ffmpeg 子进程分别处理视频与音频——
 * - 视频进程：按低帧率抽帧并输出 MJPEG（image2pipe），本模块按 JPEG 的
 *   SOI(0xFFD8)/EOI(0xFFD9) 标记把 stdout 字节流切成单帧 JPEG Buffer；
 * - 音频进程：解码为 16kHz 单声道 s16le PCM，stdout 的每个 chunk 原样透传。
 * 选双进程而非单进程多输出：两路的生命周期、错误与重连可彼此独立隔离，
 * 实现更简单、更健壮（任一路挂掉只重启自己）。
 *
 * 防注入：sourceUrl 只作为 spawn 参数数组的一个元素传入，绝不拼接进 shell
 * 字符串（对齐 src/ai/audio.ts、src/ai/whisper.ts 的既有约定）。
 *
 * push 模式扩展路径（本任务不实现）：若改用“设备主动推流”，可在本机起一个
 * 接收端（如 mediamtx 或 node-rtsp-stream），由设备把流推到该接收端，再把本
 * 网关的 sourceUrl 指向接收端的本地地址（如 rtsp://127.0.0.1:8554/live）。
 * 这样本网关的拉流逻辑无需改动，仅是把“源”从设备换成本地接收端。
 */

import { spawn } from 'node:child_process';

import { AUDIO_CHANNELS, AUDIO_FORMAT, AUDIO_SAMPLE_RATE } from './config.js';

/** JPEG 起始标记（Start Of Image）。 */
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;
/** JPEG 结束标记（End Of Image）。 */
const JPEG_EOI_0 = 0xff;
const JPEG_EOI_1 = 0xd9;

/**
 * stop() kill 子进程后，等待其 'close' 事件的最大毫秒数；到时强制结算该进程。
 * 兜底防止子进程因故永不触发 'close' 导致 stop() 永不 resolve、/api/capture/stop 挂起。
 */
const STOP_KILL_TIMEOUT_MS = 2000;

/**
 * 看门狗检查粒度（毫秒）：每隔这么久检查一次 connected 状态下是否长时间无新帧。
 * 取值远小于 stallTimeoutMs 默认值，保证僵死能被及时发现。
 */
const WATCHDOG_TICK_MS = 2000;

/** 网关运行状态机。 */
export type CaptureState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** getStatus() 返回的可观测指标。 */
export interface CaptureStatus {
  /** 当前状态 */
  state: CaptureState;
  /** 采集源地址 */
  sourceUrl: string;
  /** 视频抽帧帧率 */
  fps: number;
  /** 最近一帧的时间戳（ms，Date.now()），尚无帧时为 null */
  lastFrameAt: number | null;
  /** 累计产出的完整帧数 */
  frameCount: number;
  /** 累计透传的音频字节数 */
  audioBytes: number;
  /** 累计自动重连次数 */
  reconnectAttempts: number;
}

/** 对外网关接口。 */
export interface CaptureGateway {
  /** 启动采集（幂等：已在运行则忽略） */
  start(): void;
  /** 停止采集：标记手动停止、kill 两进程并等待退出，清除待定重连 */
  stop(): Promise<void>;
  /** 读取当前状态指标 */
  getStatus(): CaptureStatus;
  /** 读取最近一帧 JPEG Buffer；尚无帧时返回 null */
  getLatestFrame(): Buffer | null;
}

/** createCaptureGateway 入参。 */
export interface CaptureGatewayOptions {
  /** 采集源地址（ffmpeg -i 输入），只作数组参数传入，绝不拼 shell */
  sourceUrl: string;
  /** ffmpeg 可执行文件路径或命令名，缺省 'ffmpeg' */
  ffmpegPath?: string;
  /** 视频抽帧帧率，缺省 2 */
  fps?: number;
  /** 断线重连前等待毫秒数，缺省 2000 */
  reconnectDelayMs?: number;
  /** 自动重连最大次数，缺省 10；达到上限后停止自动重连。负数表示无限重连 */
  maxReconnects?: number;
  /**
   * 僵死判定阈值毫秒数，缺省 10000；connected 状态下超过该时长无新帧即判定为
   * 半开连接僵死，强杀 ffmpeg 触发重连。0 或负数关闭看门狗。
   */
  stallTimeoutMs?: number;
  /** 完整一帧 JPEG 回调：buffer 为单帧字节，timestamp 为 Date.now() */
  onFrame?: (buffer: Buffer, timestamp: number) => void;
  /** 音频 PCM chunk 回调：pcmChunk 为 s16le 字节，timestamp 为 Date.now() */
  onAudio?: (pcmChunk: Buffer, timestamp: number) => void;
  /** 错误回调：子进程错误或非手动的异常退出时触发，传原始 Error */
  onError?: (err: Error) => void;
  /** 子进程 spawn 函数，缺省 node:child_process 的 spawn（测试注入可避开真实 ffmpeg） */
  spawnFn?: typeof spawn;
}

/** spawn 返回的子进程类型（便于内部引用）。 */
type ChildProc = ReturnType<typeof spawn>;

/**
 * 创建采集网关。
 * @param options 采集参数与回调；spawnFn 供测试注入。
 */
export function createCaptureGateway(options: CaptureGatewayOptions): CaptureGateway {
  const sourceUrl = options.sourceUrl;
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const fps = options.fps ?? 2;
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  const maxReconnects = options.maxReconnects ?? 10;
  const stallTimeoutMs = options.stallTimeoutMs ?? 10000;
  const spawnFn = options.spawnFn ?? spawn;

  // 回调（均可选，缺省空实现，调用处无需判空）
  const onFrame = options.onFrame ?? (() => {});
  const onAudio = options.onAudio ?? (() => {});
  const onError = options.onError ?? (() => {});

  // 运行时状态
  let state: CaptureState = 'idle';
  let latestFrame: Buffer | null = null;
  let lastFrameAt: number | null = null;
  let frameCount = 0;
  let audioBytes = 0;
  let reconnectAttempts = 0;

  // 子进程句柄与标志
  let videoProc: ChildProc | null = null;
  let audioProc: ChildProc | null = null;
  let manualStop = false; // stop() 置位，用于区分“手动停止”与“异常退出”
  let running = false; // start() 后置位，用于 start 幂等
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 内部「最近活动时刻」：每次连接建立或切出一帧时刷新，供看门狗判定僵死。
   * 与对外指标 lastFrameAt 解耦——重连后旧帧时间已无参考意义，而 lastFrameAt
   * 需保留「最近一次真实出帧」语义供 /api/capture/status 观测。
   */
  let lastActivityAt = 0;

  // 视频帧增量解析缓冲：累积 stdout chunk，按 SOI/EOI 切帧
  let frameBuffer: Buffer = Buffer.alloc(0);

  /**
   * 从累积缓冲中增量切出完整 JPEG 帧。
   * 规则：找到 SOI(FFD8) 作为帧首，再找其后的 EOI(FFD9) 作为帧尾；切出 [SOI..EOI]
   * 一帧并前移游标；SOI 之前的垃圾字节丢弃。缓冲中可能残留半帧，留待下次 chunk。
   */
  function extractFrames(): void {
    // 丢弃首个 SOI 之前的无效字节
    let soi = indexOfMarker(frameBuffer, JPEG_SOI_0, JPEG_SOI_1, 0);
    if (soi < 0) {
      // 尚无 SOI：保留极少量尾字节以防跨 chunk 的 FF 被截断
      if (frameBuffer.length > 1) {
        frameBuffer = frameBuffer.subarray(frameBuffer.length - 1);
      }
      return;
    }
    if (soi > 0) {
      frameBuffer = frameBuffer.subarray(soi);
      soi = 0;
    }

    // 从 SOI 之后寻找 EOI，循环切出所有已完整的帧
    for (;;) {
      const eoi = indexOfMarker(frameBuffer, JPEG_EOI_0, JPEG_EOI_1, soi + 2);
      if (eoi < 0) {
        // 还没收到帧尾，保留当前（半帧）缓冲等待后续 chunk
        return;
      }
      const frameEnd = eoi + 2; // 含 EOI 两字节
      const frame = frameBuffer.subarray(0, frameEnd);
      // 复制一份独立 Buffer，避免后续 subarray 共享底层内存被覆盖
      const frameCopy = Buffer.from(frame);
      latestFrame = frameCopy;
      lastFrameAt = Date.now();
      // 看门狗活性信号：有帧产出说明拉流链路仍活着
      lastActivityAt = lastFrameAt;
      frameCount += 1;
      onFrame(frameCopy, lastFrameAt);

      // 前移到下一帧：剩余部分从 frameEnd 开始
      frameBuffer = frameBuffer.subarray(frameEnd);
      // 定位下一帧 SOI
      const next = indexOfMarker(frameBuffer, JPEG_SOI_0, JPEG_SOI_1, 0);
      if (next < 0) {
        frameBuffer = Buffer.alloc(0);
        return;
      }
      if (next > 0) {
        frameBuffer = frameBuffer.subarray(next);
      }
      soi = 0;
    }
  }

  /** 启动视频抽帧子进程（image2pipe + mjpeg）。 */
  function spawnVideo(): void {
    // 参数数组：sourceUrl 仅作 -i 的值，绝不拼接 shell 字符串（防注入）
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourceUrl,
      '-r',
      String(fps),
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ];
    const child = spawnFn(ffmpegPath, args);
    videoProc = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      frameBuffer = frameBuffer.length === 0 ? chunk : Buffer.concat([frameBuffer, chunk]);
      extractFrames();
    });
    // stderr 不解析，丢弃避免管道缓冲占用
    child.stderr?.resume();

    child.on('error', (err: Error) => handleProcFailure(err));
    child.on('close', () => handleProcClose());
  }

  /** 启动音频解码子进程（16kHz 单声道 s16le PCM）。 */
  function spawnAudio(): void {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      sourceUrl,
      '-vn',
      '-ar',
      String(AUDIO_SAMPLE_RATE),
      '-ac',
      String(AUDIO_CHANNELS),
      '-f',
      AUDIO_FORMAT,
      'pipe:1',
    ];
    const child = spawnFn(ffmpegPath, args);
    audioProc = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      audioBytes += chunk.length;
      onAudio(chunk, Date.now());
    });
    child.stderr?.resume();

    child.on('error', (err: Error) => handleProcFailure(err));
    child.on('close', () => handleProcClose());
  }

  /** 同时拉起两路子进程，并把状态置为 connected。 */
  function spawnBoth(): void {
    frameBuffer = Buffer.alloc(0);
    // 连接建立即视为一次活动起点：设备正常时应很快出首帧，迟迟无帧由看门狗接管
    lastActivityAt = Date.now();
    spawnVideo();
    spawnAudio();
    // 两进程均已成功构造（spawn 失败走异步 error 事件），标记为已连接
    state = 'connected';
    startWatchdog();
  }

  /**
   * 启动看门狗：connected 状态下定期检查最近活动时刻，超时判定为「半开连接僵死」。
   *
   * 为什么需要：ffmpeg 与手机 IP Webcam 之间的连接可能半开——TCP 未断、进程仍存活，
   * 但不再产出任何数据。此时子进程不会触发 'close'/'error'，仅靠事件驱动的重连
   * 永远不会发生，网关会一直显示 connected 却再无新帧。看门狗用「主动超时」兜住
   * 这类沉默故障：强杀两路子进程，交给既有重连流程重新拉起。
   *
   * stallTimeoutMs ≤ 0 时关闭（测试或特殊部署可显式禁用）。
   */
  function startWatchdog(): void {
    stopWatchdog();
    if (stallTimeoutMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      // 仅在 connected 状态判定：connecting/reconnecting/stopped 不由看门狗干预
      if (state !== 'connected') {
        return;
      }
      if (Date.now() - lastActivityAt <= stallTimeoutMs) {
        return;
      }
      // 僵死：进程可能仍存活，必须主动 kill 才能腾出句柄重新拉流
      killProcs();
      scheduleReconnect();
    }, WATCHDOG_TICK_MS);
    // unref：看门狗只为运行中的网关服务，不应阻止 Node 进程退出（测试更友好）
    timer.unref?.();
    watchdogTimer = timer;
  }

  /** 停止看门狗（幂等）。 */
  function stopWatchdog(): void {
    if (watchdogTimer !== null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  /**
   * 子进程 error（含 spawn ENOENT）处理：手动停止期间忽略；否则上报错误并触发重连。
   */
  function handleProcFailure(err: Error): void {
    if (manualStop) {
      return;
    }
    onError(err);
    scheduleReconnect();
  }

  /**
   * 子进程 close 处理：手动停止期间忽略；否则视为异常断线并触发重连。
   */
  function handleProcClose(): void {
    if (manualStop) {
      return;
    }
    scheduleReconnect();
  }

  /**
   * 安排一次重连：先确保两路旧进程被清理，达到上限则停止自动重连并保持状态可观测，
   * 否则在 reconnectDelayMs 后重新拉起两路进程。用 reconnectTimer 去重，避免两路
   * 子进程同时失败触发多次重连竞态。
   */
  function scheduleReconnect(): void {
    // 已安排过重连则不重复安排（两路可能几乎同时触发 close/error）
    if (reconnectTimer !== null) {
      return;
    }
    // 已达上限：停止自动重连，保持 reconnecting->? 可观测，等待手动再 start()
    // maxReconnects < 0 表示无限重连（家用设备常掉线，不应耗尽次数后永久放弃）
    if (maxReconnects >= 0 && reconnectAttempts >= maxReconnects) {
      state = 'reconnecting';
      return;
    }
    state = 'reconnecting';
    // 清理可能仍存活的另一路进程，避免僵尸进程
    killProcs();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (manualStop) {
        return;
      }
      reconnectAttempts += 1;
      spawnBoth();
    }, reconnectDelayMs);
  }

  /** kill 两路子进程（先 SIGTERM，兜底 SIGKILL），并解除句柄引用。 */
  function killProcs(): void {
    for (const proc of [videoProc, audioProc]) {
      if (proc === null) {
        continue;
      }
      try {
        proc.kill('SIGTERM');
        // 兜底：若 SIGTERM 未能结束，强制 SIGKILL（已退出的进程 kill 是无害 no-op）
        proc.kill('SIGKILL');
      } catch {
        // 进程可能已退出，kill 抛错无需处理
      }
    }
    videoProc = null;
    audioProc = null;
  }

  function start(): void {
    // 幂等：已在运行则忽略
    if (running) {
      return;
    }
    running = true;
    manualStop = false;
    reconnectAttempts = 0;
    state = 'connecting';
    spawnBoth();
  }

  /**
   * 停止采集。无论网关当前处于何种状态（idle/connecting/connected/reconnecting/stopped）
   * 都保证在有限时间内 resolve，使 /api/capture/stop 绝不挂起。
   *
   * 健壮性要点：
   * - 先置 manualStop/running、清 reconnectTimer，确保此后任何 close/error 不再触发重连，
   *   也打断 reconnecting 周期（无论定时器待定还是已达上限）。
   * - 快照两路句柄后立即置 null，避免后续路径再引用已被接管的进程。
   * - 对「已退出」(exitCode !== null) 或「kill 已投递」(killed === true) 的进程直接短路，
   *   不再等待可能已经发生、不会再次触发的一次性 'close' 事件（修复主挂起 bug）。
   * - 对仍需等待的进程，用「'close' 事件 或 STOP_KILL_TIMEOUT_MS 超时」二选一结算，
   *   per-proc settled 标志防重复计数，所有进程结算后统一 finish()。
   * - 幂等：重复调用 / 未 start 直接 stop / reconnecting 中途 stop，等待集均为空或可结算，必然 resolve。
   */
  function stop(): Promise<void> {
    // 置手动停止标志，使后续 close/error 不再触发重连
    manualStop = true;
    running = false;

    // 停掉看门狗：停止后不再判定僵死，避免其再拉起进程
    stopWatchdog();

    // 清除待定重连定时器，避免重连竞态并打断重连循环
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // 快照两路句柄后立即置 null：后续任何路径都不再引用这两个进程
    const snapshot = [videoProc, audioProc];
    videoProc = null;
    audioProc = null;

    // 仅收集「仍存活、需等待退出」的进程：
    // 为 null、已退出(exitCode 非 null)或 kill 已投递(killed) 的进程无需等待（已结算短路）。
    const procs: ChildProc[] = [];
    for (const proc of snapshot) {
      if (proc === null) {
        continue;
      }
      // kill 两路（先 SIGTERM，兜底 SIGKILL）；已退出的进程 kill 为无害 no-op
      try {
        proc.kill('SIGTERM');
        proc.kill('SIGKILL');
      } catch {
        // 进程可能已退出，kill 抛错无需处理
      }
      // kill 后再判断：若此刻已退出或 kill 已投递，则不等待其 'close'（避免等不到的一次性事件）
      if (proc.exitCode !== null || proc.killed === true) {
        continue;
      }
      procs.push(proc);
    }

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        state = 'stopped';
        resolve();
      };

      // 等待集为空（无存活进程 / 均已退出 / 幂等重复调用）→ 立即 resolve
      if (procs.length === 0) {
        finish();
        return;
      }

      let remaining = procs.length;
      for (const proc of procs) {
        // 每个进程以「close 或 超时」二选一结算，settled 防止二者都触发时重复计数
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onClose = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          remaining -= 1;
          if (remaining === 0) {
            finish();
          }
        };
        proc.once('close', onClose);
        // 兜底超时：即便进程永不触发 'close'，到时也强制结算该进程
        timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          timer = null;
          proc.removeListener('close', onClose);
          remaining -= 1;
          if (remaining === 0) {
            finish();
          }
        }, STOP_KILL_TIMEOUT_MS);
      }
    });
  }

  function getStatus(): CaptureStatus {
    return {
      state,
      sourceUrl,
      fps,
      lastFrameAt,
      frameCount,
      audioBytes,
      reconnectAttempts,
    };
  }

  function getLatestFrame(): Buffer | null {
    return latestFrame;
  }

  return { start, stop, getStatus, getLatestFrame };
}

/**
 * 在 buffer 中从 from 起查找连续两字节标记 [b0, b1] 的起始下标；未找到返回 -1。
 * 用于定位 JPEG 的 SOI(FFD8) / EOI(FFD9)。
 */
function indexOfMarker(buffer: Buffer, b0: number, b1: number, from: number): number {
  for (let i = Math.max(0, from); i + 1 < buffer.length; i += 1) {
    if (buffer[i] === b0 && buffer[i + 1] === b1) {
      return i;
    }
  }
  return -1;
}
