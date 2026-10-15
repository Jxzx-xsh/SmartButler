/**
 * 门控协调器（Gating Controller）。
 *
 * 把 FEAT-001 的两个检测器组合成一个统一入口：
 * - 视频：processFrame(jpeg, ts) 转交 motionDetector.processFrame（异步，sharp 解码），
 *   命中时产出统一的 VideoMotionEvent（含触发帧）并派发给 onVideoMotion 订阅者；
 * - 音频：processAudio(pcm, ts) 转交 vad.processAudio（同步，返回事件数组），
 *   逐个产出 AudioActivityEvent 并派发给 onAudioActivity 订阅者。
 * processFrame/processAudio 的对外签名均为 (Buffer, number) => void，可直接作为
 * 采集网关的 onFrame/onAudio 回调接入（见 src/capture/gateway.ts 回调契约）。
 *
 * 关于视频帧的串行化：motionDetector.processFrame 内部 await sharp 解码为异步，
 * 若并发处理多帧会导致基线更新与事件派发乱序。故这里维护一个 pending Promise
 * 链，把每帧的处理 .then 接到链尾，保证按投喂顺序逐帧处理；单帧解码失败只走
 * onError 不中断整条链。processFrame 本身返回 void（内部异步），避免上层网关
 * 回调被迫 await。
 */

import type { AudioActivityEvent } from './vad.js';
import type { MotionDetector } from './motion.js';
import type { Vad } from './vad.js';

/** 门控运行指标。 */
export interface GatingStats {
  /** 累计处理的视频帧数（每次 processFrame 计一次）。 */
  framesProcessed: number;
  /** 累计产出的运动事件数。 */
  motionEvents: number;
  /** 累计处理的音频字节数（每次 processAudio 的 pcm.length 累加）。 */
  audioBytesProcessed: number;
  /** 累计产出的音频活动事件数。 */
  audioEvents: number;
  /** 最近一次运动事件时间戳（ms）；尚无则为 null。 */
  lastMotionAt: number | null;
  /** 最近一次音频活动事件结束时间戳（ms）；尚无则为 null。 */
  lastAudioAt: number | null;
  /** 当前是否处于语音活动中（最近收到的音频事件开始/结束推断）。 */
  speaking: boolean;
}

/** 统一视频运动事件（由 MotionEvent 映射而来）。 */
export interface VideoMotionEvent {
  /** 事件时间戳（取触发帧的 timestamp，毫秒）。 */
  timestamp: number;
  /** 触发帧相对上一帧的变化像素占比（0..1）。 */
  changedRatio: number;
  /** 触发帧的原始 JPEG Buffer（即传入 processFrame 的 buffer）。 */
  frame: Buffer;
}

/** 音频活动事件直接复用 vad.ts 的类型。 */
export type { AudioActivityEvent } from './vad.js';

/**
 * 可选的实时说话态接口：若注入的 vad 额外实现 isSpeaking()，门控优先用它推断
 * speaking。FEAT-001 的 Vad 当前未实现，故为可选的鸭子类型。
 */
interface MaybeSpeaking {
  isSpeaking(): boolean;
}

/** 判断 vad 是否暴露了 isSpeaking()（鸭子类型探测）。 */
function hasIsSpeaking(vad: Vad): vad is Vad & MaybeSpeaking {
  return typeof (vad as Partial<MaybeSpeaking>).isSpeaking === 'function';
}

/** 门控协调器实例。 */
export interface GatingController {
  /**
   * 处理一帧 JPEG（内部异步串行化）。可直接作为网关 onFrame 回调接入。
   * @param jpeg 完整单帧 JPEG Buffer。
   * @param ts 帧时间戳（ms）。
   */
  processFrame(jpeg: Buffer, ts: number): void;
  /**
   * 处理一个音频 PCM chunk（同步）。可直接作为网关 onAudio 回调接入。
   * @param pcm s16le 原始 PCM chunk。
   * @param ts chunk 时间戳（ms）。
   */
  processAudio(pcm: Buffer, ts: number): void;
  /** 订阅视频运动事件（可多次订阅，命中时逐个回调）。 */
  onVideoMotion(cb: (e: VideoMotionEvent) => void): void;
  /** 订阅音频活动事件（可多次订阅，产出时逐个回调）。 */
  onAudioActivity(cb: (e: AudioActivityEvent) => void): void;
  /** 读取当前门控运行指标快照。 */
  getStats(): GatingStats;
}

/** 门控协调器构造选项。 */
export interface GatingControllerOptions {
  /** 注入的移动侦测器（通常来自 createMotionDetector）。 */
  motionDetector: MotionDetector;
  /** 注入的 VAD（通常来自 createVad）。 */
  vad: Vad;
  /** 可选错误回调：帧解码失败等异常时触发（不中断处理链）。 */
  onError?: (err: Error) => void;
}

/**
 * 创建门控协调器。
 * @param options 注入的 motionDetector/vad 与可选 onError（替身便于单测）。
 */
export function createGatingController(options: GatingControllerOptions): GatingController {
  const { motionDetector, vad } = options;
  const onError = options.onError ?? (() => {});

  // 订阅者列表
  const videoSubscribers: Array<(e: VideoMotionEvent) => void> = [];
  const audioSubscribers: Array<(e: AudioActivityEvent) => void> = [];

  // 运行指标
  let framesProcessed = 0;
  let motionEvents = 0;
  let audioBytesProcessed = 0;
  let audioEvents = 0;
  let lastMotionAt: number | null = null;
  let lastAudioAt: number | null = null;
  let speaking = false;

  // 视频帧串行化：pending 链尾，保证按投喂顺序逐帧处理
  let pending: Promise<void> = Promise.resolve();

  return {
    processFrame(jpeg: Buffer, ts: number): void {
      framesProcessed += 1;
      // 把本帧处理接到链尾：等上一帧结算后再 await 本帧解码，保证顺序
      pending = pending.then(async () => {
        try {
          const event = await motionDetector.processFrame(jpeg, ts);
          if (event !== null) {
            motionEvents += 1;
            lastMotionAt = event.timestamp;
            // 映射为统一 VideoMotionEvent 并派发
            const videoEvent: VideoMotionEvent = {
              timestamp: event.timestamp,
              changedRatio: event.changedRatio,
              frame: event.frame,
            };
            for (const cb of videoSubscribers) {
              cb(videoEvent);
            }
          }
        } catch (err) {
          // 解码失败只上报，不中断后续帧的处理链
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    processAudio(pcm: Buffer, ts: number): void {
      audioBytesProcessed += pcm.length;
      const events = vad.processAudio(pcm, ts);
      for (const event of events) {
        audioEvents += 1;
        lastAudioAt = event.endTimestamp;
        for (const cb of audioSubscribers) {
          cb(event);
        }
      }
      // speaking 的推断：优先用 vad 暴露的 isSpeaking()（实时说话态）；若 vad 未暴露，
      // 则在控制器侧依据「本次是否产出事件」近似——产出事件表示刚结束一段活动，
      // 故回到不说话（false）；本次无事件则维持上一次推断不变。
      if (hasIsSpeaking(vad)) {
        speaking = vad.isSpeaking();
      } else if (events.length > 0) {
        speaking = false;
      }
    },
    onVideoMotion(cb: (e: VideoMotionEvent) => void): void {
      videoSubscribers.push(cb);
    },
    onAudioActivity(cb: (e: AudioActivityEvent) => void): void {
      audioSubscribers.push(cb);
    },
    getStats(): GatingStats {
      return {
        framesProcessed,
        motionEvents,
        audioBytesProcessed,
        audioEvents,
        lastMotionAt,
        lastAudioAt,
        speaking,
      };
    },
  };
}
