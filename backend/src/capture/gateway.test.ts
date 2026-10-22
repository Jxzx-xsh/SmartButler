/** 采集网关单元测试（全程 mock spawn，不依赖真实 ffmpeg）。 */

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCaptureGateway } from './gateway.js';

/**
 * fake 子进程：EventEmitter + stdout/stderr（也是 EventEmitter，带 resume）+ kill。
 * 由测试直接 emit stdout 'data' / 'close' / 'error' 驱动，范式照 whisper.test.ts。
 */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { resume: () => {} });
  stderr = Object.assign(new EventEmitter(), { resume: () => {} });
  // 进程退出可观测字段：默认 null/false 与真实未退出子进程一致；
  // kill 被调用时置 killed=true，供 stop() 的「已退出短路」判断与断言使用。
  exitCode: number | null = null;
  killed = false;
  pid = 1234;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

type SpawnLike = typeof import('node:child_process').spawn;

/**
 * 构造一个按调用顺序返回预置 FakeChild 的 spawnFn，并记录每次调用的 (cli, args)。
 * 视频/音频两路在 start/重连时按 spawnVideo → spawnAudio 的顺序各调一次 spawn。
 */
function makeSpawnFn(children: FakeChild[]) {
  const calls: Array<{ cli: string; args: string[] }> = [];
  let idx = 0;
  const spawnFn = vi.fn((cli: string, args: string[]) => {
    calls.push({ cli, args });
    const child = children[idx] ?? new FakeChild();
    idx += 1;
    return child as unknown as ReturnType<SpawnLike>;
  });
  return { spawnFn: spawnFn as unknown as SpawnLike, calls, mock: spawnFn };
}

/** 组装一帧最小 JPEG 字节：SOI(FFD8) + payload + EOI(FFD9)。 */
function makeJpeg(payload: number[] = [0x01, 0x02, 0x03]): Buffer {
  return Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}

/** 取第 idx 个 fake 子进程；越界直接抛错（兼容 noUncheckedIndexedAccess 的 undefined 推断）。 */
function childAt(children: FakeChild[], idx: number): FakeChild {
  const child = children[idx];
  if (child === undefined) {
    throw new Error(`测试缺少第 ${idx} 个 fake 子进程`);
  }
  return child;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('createCaptureGateway.start', () => {
  it('为视频与音频分别构造正确的 ffmpeg 参数数组（含 -i sourceUrl，防注入）', () => {
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn, calls, mock } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'http://192.168.1.9:8080/video',
      ffmpegPath: 'ffmpeg',
      fps: 3,
      spawnFn,
    });

    gw.start();

    expect(mock).toHaveBeenCalledTimes(2);
    const videoArgs = calls[0]?.args ?? [];
    const audioArgs = calls[1]?.args ?? [];

    // 视频：-i <url> -r 3 -f image2pipe -vcodec mjpeg pipe:1
    expect(videoArgs).toContain('-i');
    const vIdx = videoArgs.indexOf('-i');
    expect(videoArgs[vIdx + 1]).toBe('http://192.168.1.9:8080/video');
    expect(videoArgs).toContain('-r');
    expect(videoArgs[videoArgs.indexOf('-r') + 1]).toBe('3');
    expect(videoArgs).toContain('image2pipe');
    expect(videoArgs[videoArgs.length - 1]).toBe('pipe:1');

    // 音频：-i <url> -vn -ar 16000 -ac 1 -f s16le pipe:1
    expect(audioArgs).toContain('-i');
    const aIdx = audioArgs.indexOf('-i');
    expect(audioArgs[aIdx + 1]).toBe('http://192.168.1.9:8080/video');
    expect(audioArgs).toContain('-vn');
    expect(audioArgs[audioArgs.indexOf('-ar') + 1]).toBe('16000');
    expect(audioArgs[audioArgs.indexOf('-ac') + 1]).toBe('1');
    expect(audioArgs).toContain('s16le');
    expect(audioArgs[audioArgs.length - 1]).toBe('pipe:1');

    // sourceUrl 只作数组元素，cli 本身是 ffmpeg（无 shell 拼接）
    expect(calls[0]?.cli).toBe('ffmpeg');
    expect(gw.getStatus().state).toBe('connected');
  });

  it('start 幂等：重复调用不重复 spawn', () => {
    const { spawnFn, mock } = makeSpawnFn([new FakeChild(), new FakeChild()]);
    const gw = createCaptureGateway({ sourceUrl: 'rtsp://x/y', spawnFn });
    gw.start();
    gw.start();
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('视频帧解析', () => {
  it('stdout 投喂含 FFD8..FFD9 的字节 → onFrame 得完整 JPEG，getLatestFrame 返回之，frameCount+1', () => {
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio]);
    const frames: Buffer[] = [];
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      onFrame: (buf) => frames.push(buf),
    });
    gw.start();

    const jpeg = makeJpeg([0xaa, 0xbb]);
    video.stdout.emit('data', jpeg);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.equals(jpeg)).toBe(true);
    expect(gw.getLatestFrame()?.equals(jpeg)).toBe(true);
    expect(gw.getStatus().frameCount).toBe(1);
    expect(gw.getStatus().lastFrameAt).not.toBeNull();
  });

  it('跨 chunk 的半帧能被拼接；一个 chunk 含两帧能切出两帧', () => {
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio]);
    const frames: Buffer[] = [];
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      onFrame: (buf) => frames.push(buf),
    });
    gw.start();

    // 半帧：SOI + payload（无 EOI）
    video.stdout.emit('data', Buffer.from([0xff, 0xd8, 0x11]));
    expect(frames).toHaveLength(0);
    // 补上 EOI + 紧接着的完整第二帧
    video.stdout.emit('data', Buffer.from([0x22, 0xff, 0xd9, 0xff, 0xd8, 0x33, 0xff, 0xd9]));

    expect(frames).toHaveLength(2);
    expect(frames[0]?.equals(Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]))).toBe(true);
    expect(frames[1]?.equals(Buffer.from([0xff, 0xd8, 0x33, 0xff, 0xd9]))).toBe(true);
    expect(gw.getStatus().frameCount).toBe(2);
  });
});

describe('音频透传', () => {
  it('音频 stdout 投喂 chunk → onAudio 被调用且 audioBytes 累加', () => {
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio]);
    const chunks: Buffer[] = [];
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      onAudio: (c) => chunks.push(c),
    });
    gw.start();

    audio.stdout.emit('data', Buffer.from([1, 2, 3, 4]));
    audio.stdout.emit('data', Buffer.from([5, 6]));

    expect(chunks).toHaveLength(2);
    expect(gw.getStatus().audioBytes).toBe(6);
  });
});

describe('健壮性：错误与重连', () => {
  it('子进程 error(ENOENT) → onError 触发且 state 转 reconnecting', () => {
    vi.useFakeTimers();
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio, new FakeChild(), new FakeChild()]);
    const errors: Error[] = [];
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      reconnectDelayMs: 2000,
      maxReconnects: 3,
      onError: (e) => errors.push(e),
    });
    gw.start();

    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    video.emit('error', enoent);

    expect(errors).toHaveLength(1);
    expect(gw.getStatus().state).toBe('reconnecting');
  });

  it('断线后推进 reconnectDelayMs 会重新 spawn，达到 maxReconnects 后不再重连', () => {
    vi.useFakeTimers();
    // 预置足够多 FakeChild：初始 2 + 每次重连 2
    const kids = Array.from({ length: 10 }, () => new FakeChild());
    const { spawnFn, mock } = makeSpawnFn(kids);
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      reconnectDelayMs: 1000,
      maxReconnects: 2,
    });
    gw.start();
    expect(mock).toHaveBeenCalledTimes(2); // 初始视频+音频

    // 第 1 次断线 → 定时器推进后重连（+2 spawn）
    kids[0]?.emit('close', 1);
    vi.advanceTimersByTime(1000);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(gw.getStatus().reconnectAttempts).toBe(1);

    // 第 2 次断线 → 再重连（+2 spawn）
    kids[2]?.emit('close', 1);
    vi.advanceTimersByTime(1000);
    expect(mock).toHaveBeenCalledTimes(6);
    expect(gw.getStatus().reconnectAttempts).toBe(2);

    // 第 3 次断线 → 已达上限，不再 spawn
    kids[4]?.emit('close', 1);
    vi.advanceTimersByTime(1000);
    expect(mock).toHaveBeenCalledTimes(6);
    expect(gw.getStatus().reconnectAttempts).toBe(2);
    expect(gw.getStatus().state).toBe('reconnecting');
  });

  it('两路几乎同时断线只触发一次重连（去重）', () => {
    vi.useFakeTimers();
    const kids = Array.from({ length: 6 }, () => new FakeChild());
    const { spawnFn, mock } = makeSpawnFn(kids);
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      reconnectDelayMs: 1000,
      maxReconnects: 5,
    });
    gw.start();
    expect(mock).toHaveBeenCalledTimes(2);

    kids[0]?.emit('close', 1);
    kids[1]?.emit('close', 1);
    vi.advanceTimersByTime(1000);

    // 仅一次重连 → 共 4 次 spawn，reconnectAttempts 为 1
    expect(mock).toHaveBeenCalledTimes(4);
    expect(gw.getStatus().reconnectAttempts).toBe(1);
  });
});

describe('stop 生命周期', () => {
  it('stop() 调两路 kill 后 state 转 stopped，且不再重连', async () => {
    vi.useFakeTimers();
    const video = new FakeChild();
    const audio = new FakeChild();
    const extra = new FakeChild();
    const { spawnFn, mock } = makeSpawnFn([video, audio, extra, new FakeChild()]);
    const gw = createCaptureGateway({
      sourceUrl: 'http://x/video',
      spawnFn,
      reconnectDelayMs: 1000,
      maxReconnects: 5,
    });
    gw.start();

    const stopped = gw.stop();
    // stop() 应对两路都调用 kill
    expect(video.kill).toHaveBeenCalled();
    expect(audio.kill).toHaveBeenCalled();

    // kill 投递后进程视为可结算（killed=true 短路），stop() 应及时 resolve
    await stopped;
    expect(gw.getStatus().state).toBe('stopped');

    // 迟到的 close 事件无害，且手动停止后不应触发重连
    video.emit('close', 0);
    audio.emit('close', 0);
    vi.advanceTimersByTime(5000);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('stop() 在无存活进程时也能 resolve（未 start 直接 stop）', async () => {
    const { spawnFn } = makeSpawnFn([]);
    const gw = createCaptureGateway({ sourceUrl: 'http://x/video', spawnFn });
    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');
  });

  it('stop() 在 reconnecting 状态下及时 resolve（句柄已被 killProcs 置 null、定时器待定）', async () => {
    vi.useFakeTimers();
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn, mock } = makeSpawnFn([video, audio, new FakeChild(), new FakeChild()]);
    const gw = createCaptureGateway({
      sourceUrl: 'file:///tmp/x.mp4',
      spawnFn,
      reconnectDelayMs: 2000,
      maxReconnects: 10,
    });
    gw.start();

    // 一路 close 触发 scheduleReconnect：killProcs() 已把 videoProc/audioProc 置 null，
    // state=reconnecting，reconnectTimer 待定（内部句柄此刻为 null）
    video.emit('close', 1);
    expect(gw.getStatus().state).toBe('reconnecting');

    // 此时 stop()：等待集为空（句柄已 null），应在不 emit 任何新 close 的情况下立即 resolve
    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');

    // 重连被打断：推进时间不再触发新的 spawn（仍为初始 2 次）
    vi.advanceTimersByTime(10000);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('stop() 当子进程已 close（exitCode 非 null）时及时 resolve，不等不会到来的 close', async () => {
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio]);
    const gw = createCaptureGateway({ sourceUrl: 'http://x/video', spawnFn });
    gw.start();

    // 模拟句柄仍被引用但进程已退出（exitCode 非 null）
    video.exitCode = 0;
    audio.exitCode = 0;

    // 「已退出短路」生效：不依赖 close 二次触发，直接 resolve
    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');
  });

  it('stop() 幂等：未 start 连续两次 stop 均 resolve', async () => {
    const { spawnFn } = makeSpawnFn([]);
    const gw = createCaptureGateway({ sourceUrl: 'http://x/video', spawnFn });
    await gw.stop();
    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');
  });

  it('stop() 幂等：start 后 stop 两次均及时 resolve，第二次不因句柄已 null 抛错', async () => {
    const video = new FakeChild();
    const audio = new FakeChild();
    const { spawnFn } = makeSpawnFn([video, audio]);
    const gw = createCaptureGateway({ sourceUrl: 'http://x/video', spawnFn });
    gw.start();

    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');

    // 第二次 stop：句柄已置 null，等待集为空，立即 resolve 且状态保持 stopped
    await gw.stop();
    expect(gw.getStatus().state).toBe('stopped');
  });

  it('stop() 超时兜底：子进程永不发 close，推进 STOP_KILL_TIMEOUT_MS 后仍能 resolve', async () => {
    vi.useFakeTimers();
    // 子进程永不退出：kill 被 mock 覆盖为不置 killed，exitCode 保持 null、从不 emit close
    const video = new FakeChild();
    const audio = new FakeChild();
    video.kill = vi.fn(() => true);
    audio.kill = vi.fn(() => true);
    const { spawnFn } = makeSpawnFn([video, audio]);
    const gw = createCaptureGateway({ sourceUrl: 'http://x/video', spawnFn });
    gw.start();

    const stopped = gw.stop();
    // 尚未超时、也无 close：Promise 仍 pending（用竞速标记验证）
    let resolved = false;
    void stopped.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // 推进到兜底超时（源常量 STOP_KILL_TIMEOUT_MS = 2000ms）→ 强制结算并 resolve
    vi.advanceTimersByTime(2000);
    await stopped;
    expect(gw.getStatus().state).toBe('stopped');
  });
});

describe('getStatus 初始指标', () => {
  it('未 start 时指标为初始值', () => {
    const { spawnFn } = makeSpawnFn([]);
    const gw = createCaptureGateway({ sourceUrl: 'http://host/video', fps: 2, spawnFn });
    const s = gw.getStatus();
    expect(s.state).toBe('idle');
    expect(s.sourceUrl).toBe('http://host/video');
    expect(s.fps).toBe(2);
    expect(s.lastFrameAt).toBeNull();
    expect(s.frameCount).toBe(0);
    expect(s.audioBytes).toBe(0);
    expect(s.reconnectAttempts).toBe(0);
    expect(gw.getLatestFrame()).toBeNull();
  });
});

describe('createCaptureGateway 看门狗', () => {
  it('connected 状态超 stallTimeoutMs 无新帧：强杀两路子进程并触发重连', () => {
    vi.useFakeTimers();
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
    const { spawnFn, mock } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'rtsp://192.168.1.107:8080/h264_ulaw.sdp',
      reconnectDelayMs: 1000,
      stallTimeoutMs: 5000,
      spawnFn,
    });
    gw.start();
    // 视频 + 音频两路各 spawn 一次
    expect(mock).toHaveBeenCalledTimes(2);

    // 4s 内（未超阈值）看门狗不动作
    vi.advanceTimersByTime(4000);
    expect(childAt(children, 0).killed).toBe(false);
    expect(childAt(children, 1).killed).toBe(false);
    expect(gw.getStatus().state).toBe('connected');

    // 累计 6s > stallTimeoutMs(5s)：判定半开连接僵死，强杀两路并进入重连
    vi.advanceTimersByTime(2000);
    expect(childAt(children, 0).killed).toBe(true);
    expect(childAt(children, 1).killed).toBe(true);
    expect(gw.getStatus().state).toBe('reconnecting');

    // 推进 reconnectDelayMs：重新拉起两路，状态回到 connected
    vi.advanceTimersByTime(1000);
    expect(mock).toHaveBeenCalledTimes(4);
    expect(gw.getStatus().state).toBe('connected');
  });

  it('持续出帧时看门狗不误判（每帧刷新活动时刻）', () => {
    vi.useFakeTimers();
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'rtsp://host/stream',
      reconnectDelayMs: 1000,
      stallTimeoutMs: 5000,
      spawnFn,
    });
    gw.start();

    // 每 2s 一帧，跨 10s（远超阈值总时长）仍应保持 connected
    for (let i = 0; i < 5; i += 1) {
      childAt(children, 0).stdout.emit('data', makeJpeg());
      vi.advanceTimersByTime(2000);
    }

    expect(childAt(children, 0).killed).toBe(false);
    expect(gw.getStatus().state).toBe('connected');
    expect(gw.getStatus().frameCount).toBe(5);
  });

  it('stop() 后看门狗停止，不再拉起新进程', async () => {
    vi.useFakeTimers();
    const children = [new FakeChild(), new FakeChild(), new FakeChild(), new FakeChild()];
    const { spawnFn, mock } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'rtsp://host/stream',
      reconnectDelayMs: 100,
      stallTimeoutMs: 1000,
      spawnFn,
    });
    gw.start();
    await gw.stop();

    const spawnCountAfterStop = mock.mock.calls.length;
    // 远超僵死阈值：若看门狗仍在跑会强杀并重新 spawn
    vi.advanceTimersByTime(10000);
    expect(mock.mock.calls.length).toBe(spawnCountAfterStop);
    expect(gw.getStatus().state).toBe('stopped');
  });

  it('stallTimeoutMs 为 0 时关闭看门狗：超时无帧也不触发重连', () => {
    vi.useFakeTimers();
    const children = [new FakeChild(), new FakeChild()];
    const { spawnFn, mock } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'rtsp://host/stream',
      reconnectDelayMs: 1000,
      stallTimeoutMs: 0,
      spawnFn,
    });
    gw.start();

    vi.advanceTimersByTime(60000);
    expect(childAt(children, 0).killed).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(gw.getStatus().state).toBe('connected');
  });
});

describe('createCaptureGateway 无限重连', () => {
  it('maxReconnects 为负数：断线次数不限，始终回到 connected', () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    for (let i = 0; i < 20; i += 1) {
      children.push(new FakeChild());
    }
    const { spawnFn, mock } = makeSpawnFn(children);
    const gw = createCaptureGateway({
      sourceUrl: 'rtsp://host/stream',
      reconnectDelayMs: 1000,
      // 负数 = 无限重连；关闭看门狗以免干扰本测试的重连计数
      maxReconnects: -1,
      stallTimeoutMs: 0,
      spawnFn,
    });
    gw.start();
    expect(mock).toHaveBeenCalledTimes(2);

    // 连续断线 6 次（远超 maxReconnects 缺省 10 的一半，但关键是远少于「无限」）
    for (let i = 0; i < 6; i += 1) {
      // 第 i 轮的视频进程在 children[2i]
      childAt(children, i * 2).emit('close');
      vi.advanceTimersByTime(1000);
    }

    expect(gw.getStatus().state).toBe('connected');
    expect(gw.getStatus().reconnectAttempts).toBe(6);
    // 每次重连各 spawn 视频 + 音频
    expect(mock).toHaveBeenCalledTimes(2 + 6 * 2);
  });
});
