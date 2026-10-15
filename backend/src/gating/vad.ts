/**
 * 语音活动检测（VAD，Voice Activity Detection）。
 *
 * 处理来自采集网关 onAudio 回调的 16kHz 单声道 s16le 原始 PCM chunk
 * （无 WAV 头、样本为小端 Int16），把音频按固定帧长切分，逐帧计算短时
 * RMS 能量，用「silence → speech → silence」三态机识别一段语音活动：
 *   - silence 态：连续超阈值累计达 triggerMs 则进入 speech（起点回推 triggerMs 更准）；
 *   - speech 态：连续低于阈值累计达 hangoverMs 则回到 silence 并结算一个段；
 *   - 段时长 < minEventMs 丢弃；与上一段间隔 < cooldownMs 的段抑制。
 * 一次 processAudio 可能跨多帧并产出 0..n 个事件，返回数组。
 *
 * 为什么用能量阈值而非 silero(onnx)：家庭场景下短时 RMS 能量阈值已足够区分
 * 有声/静音，且零额外依赖、延迟低；silero VAD（onnxruntime）作为可选增强，
 * 仅在此说明扩展路径——可在 speech 判定处替换为 silero 模型打分，本任务不实现。
 */

import { AUDIO_SAMPLE_RATE } from '../capture/config.js';

/** 每个 s16le 样本占用的字节数（有符号 16 位 = 2 字节）。 */
const BYTES_PER_SAMPLE = 2;

/**
 * 计算一段 PCM 的短时 RMS 能量（纯函数）。
 * @param pcm s16le 原始 PCM Buffer（样本为小端 Int16）。
 * @param byteOffset 起始字节偏移（须为偶数，对齐样本边界）。
 * @param sampleCount 要读取的样本数。
 * @returns 均方根能量（0..32767）；sampleCount ≤ 0 时返回 0。
 */
export function frameRms(pcm: Buffer, byteOffset: number, sampleCount: number): number {
  if (sampleCount <= 0) {
    return 0;
  }
  let squareSum = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = pcm.readInt16LE(byteOffset + i * BYTES_PER_SAMPLE);
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / sampleCount);
}

/** 一次语音活动事件。 */
export interface AudioActivityEvent {
  /** 段起始时间戳（毫秒，起点已回推 triggerMs）。 */
  startTimestamp: number;
  /** 段结束时间戳（毫秒）。 */
  endTimestamp: number;
  /** 段时长（毫秒）。 */
  durationMs: number;
  /** 段内帧数。 */
  frameCount: number;
  /** 可选：该段聚合的原始 PCM（s16le）。 */
  pcm?: Buffer;
}

/** VAD 构造选项。 */
export interface VadOptions {
  /** RMS 能量阈值（0..32767）。 */
  energyThreshold: number;
  /** 帧长（毫秒）。 */
  frameMs: number;
  /** 连续超阈值累计达此时长（ms）进入 speech。 */
  triggerMs: number;
  /** 连续低于阈值累计达此时长（ms）回到 silence。 */
  hangoverMs: number;
  /** 段时长小于此值（ms）丢弃。 */
  minEventMs: number;
  /** 两段事件之间的冷却毫秒数。 */
  cooldownMs: number;
  /** 采样率（Hz），缺省复用 AUDIO_SAMPLE_RATE（16000）。 */
  sampleRate?: number;
}

/** VAD 实例。 */
export interface Vad {
  /**
   * 处理一个 PCM chunk，按帧推进状态机。
   * @returns 本次处理结算出的语音活动事件数组（可能为空）。
   */
  processAudio(pcmChunk: Buffer, timestamp: number): AudioActivityEvent[];
  /** 重置内部状态（残留缓冲、状态机、时间原点）。 */
  reset(): void;
}

/** 内部状态机状态。 */
type VadState = 'silence' | 'speech';

/**
 * 创建一个基于能量阈值的 VAD。
 * @param options 阈值、帧长、触发/挂起/最小事件/冷却时长与可选采样率。
 */
export function createVad(options: VadOptions): Vad {
  const {
    energyThreshold,
    frameMs,
    triggerMs,
    hangoverMs,
    minEventMs,
    cooldownMs,
    sampleRate = AUDIO_SAMPLE_RATE,
  } = options;

  // 每帧样本数与字节数
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const bytesPerFrame = samplesPerFrame * BYTES_PER_SAMPLE;

  // 未满一帧的残留 PCM 缓冲，留到下次 processAudio 拼接
  let residual: Buffer = Buffer.alloc(0);
  // 已消费的样本总数（相对首个 chunk 的 timestamp 推算时间）
  let consumedSamples = 0;
  // 当前 chunk 的时间原点与其已消费样本基准（用于把样本数换算为绝对时间戳）
  let timeOriginMs = 0;
  let samplesAtOrigin = 0;
  // 是否已初始化过时间原点
  let originInitialized = false;

  // 状态机当前状态
  let state: VadState = 'silence';
  // silence 态下连续超阈值累计时长
  let aboveMs = 0;
  // speech 态下连续低于阈值累计时长
  let belowMs = 0;
  // 当前段：起点时间戳、帧数、聚合 PCM 分片
  let segStartMs = 0;
  let segFrameCount = 0;
  let segChunks: Buffer[] = [];
  // 上一段结束时间戳（用于冷却判定）；null 表示尚无
  let lastEventEndMs: number | null = null;

  /** 把「已消费样本数」换算为绝对时间戳（毫秒）。 */
  function sampleIndexToMs(sampleIndex: number): number {
    return timeOriginMs + ((sampleIndex - samplesAtOrigin) / sampleRate) * 1000;
  }

  return {
    processAudio(pcmChunk: Buffer, timestamp: number): AudioActivityEvent[] {
      // 首次调用（或 reset 后首次）用传入 timestamp 作为时间原点
      if (!originInitialized) {
        timeOriginMs = timestamp;
        samplesAtOrigin = consumedSamples;
        originInitialized = true;
      }

      const events: AudioActivityEvent[] = [];
      // 把残留与新 chunk 拼接，按整帧切分
      let buffer = residual.length > 0 ? Buffer.concat([residual, pcmChunk]) : pcmChunk;

      let frameOffset = 0;
      while (frameOffset + bytesPerFrame <= buffer.length) {
        const rms = frameRms(buffer, frameOffset, samplesPerFrame);
        const isLoud = rms >= energyThreshold;

        // 当前帧结束时对应的绝对时间戳
        const frameEndSampleIndex = consumedSamples + samplesPerFrame;
        const frameEndMs = sampleIndexToMs(frameEndSampleIndex);

        if (state === 'silence') {
          if (isLoud) {
            aboveMs += frameMs;
            if (aboveMs >= triggerMs) {
              // 进入 speech：起点回推 triggerMs 更贴近真实起声点
              state = 'speech';
              segStartMs = frameEndMs - triggerMs;
              // 已累计的触发帧数（含当前帧）计入段
              const triggerFrames = Math.max(1, Math.round(triggerMs / frameMs));
              segFrameCount = triggerFrames;
              segChunks = [];
              belowMs = 0;
            }
          } else {
            aboveMs = 0;
          }
        } else {
          // speech 态：累计当前帧
          segFrameCount += 1;
          if (isLoud) {
            belowMs = 0;
          } else {
            belowMs += frameMs;
            if (belowMs >= hangoverMs) {
              // 回到 silence 并结算一个段（结束点回退 hangoverMs，去掉尾部静音）
              const endMs = frameEndMs - hangoverMs;
              const durationMs = endMs - segStartMs;
              state = 'silence';
              aboveMs = 0;
              belowMs = 0;

              // 冷却判定：与上一段间隔过近则抑制
              const cooledDown =
                lastEventEndMs === null || segStartMs - lastEventEndMs >= cooldownMs;
              if (durationMs >= minEventMs && cooledDown) {
                const event: AudioActivityEvent = {
                  startTimestamp: segStartMs,
                  endTimestamp: endMs,
                  durationMs,
                  frameCount: segFrameCount,
                };
                if (segChunks.length > 0) {
                  event.pcm = Buffer.concat(segChunks);
                }
                events.push(event);
                lastEventEndMs = endMs;
              }
              segChunks = [];
              segFrameCount = 0;
            }
          }
          // speech 态聚合该帧 PCM（供可选 pcm 字段）
          segChunks.push(buffer.subarray(frameOffset, frameOffset + bytesPerFrame));
        }

        consumedSamples += samplesPerFrame;
        frameOffset += bytesPerFrame;
      }

      // 保留不足一帧的残留，留到下次拼接
      residual = frameOffset < buffer.length ? buffer.subarray(frameOffset) : Buffer.alloc(0);

      return events;
    },
    reset(): void {
      residual = Buffer.alloc(0);
      consumedSamples = 0;
      timeOriginMs = 0;
      samplesAtOrigin = 0;
      originInitialized = false;
      state = 'silence';
      aboveMs = 0;
      belowMs = 0;
      segStartMs = 0;
      segFrameCount = 0;
      segChunks = [];
      lastEventEndMs = null;
    },
  };
}
