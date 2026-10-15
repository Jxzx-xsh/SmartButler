/** VAD 单元测试：frameRms 纯函数 + createVad 能量阈值状态机（构造确定性 s16le PCM）。 */

import { describe, expect, it } from 'vitest';

import { createVad, frameRms } from './vad.js';

/** 采样率（与 AUDIO_SAMPLE_RATE 一致）。 */
const SAMPLE_RATE = 16000;

/**
 * 构造一段恒定幅值的 s16le PCM。
 * @param sampleCount 样本数。
 * @param amplitude 每个样本的幅值（Int16）。
 */
function makePcm(sampleCount: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

describe('frameRms', () => {
  it('全 0 PCM → RMS 0', () => {
    const pcm = makePcm(320, 0);
    expect(frameRms(pcm, 0, 320)).toBe(0);
  });

  it('恒定满幅方波（±30000 的 +30000 分量）→ RMS 等于幅值', () => {
    const pcm = makePcm(320, 30000);
    // 全部样本都是 30000，RMS = sqrt(mean(30000^2)) = 30000
    expect(frameRms(pcm, 0, 320)).toBeCloseTo(30000, 5);
  });

  it('byteOffset/sampleCount 边界：只统计指定窗口', () => {
    // 前 160 样本为 0，后 160 样本为 10000
    const buf = Buffer.concat([makePcm(160, 0), makePcm(160, 10000)]);
    // 只读后半段 → RMS 10000
    expect(frameRms(buf, 160 * 2, 160)).toBeCloseTo(10000, 5);
    // 只读前半段 → RMS 0
    expect(frameRms(buf, 0, 160)).toBe(0);
  });

  it('sampleCount ≤ 0 → 返回 0', () => {
    expect(frameRms(makePcm(10, 100), 0, 0)).toBe(0);
  });
});

describe('createVad', () => {
  // 20ms 帧 @16kHz = 320 样本/帧
  const samplesPerFrame = (SAMPLE_RATE * 20) / 1000; // 320
  const vadOptions = {
    energyThreshold: 500,
    frameMs: 20,
    triggerMs: 40, // 2 帧触发
    hangoverMs: 60, // 3 帧挂起
    minEventMs: 20,
    cooldownMs: 0,
    sampleRate: SAMPLE_RATE,
  };

  /** 生成 n 帧静音 PCM。 */
  function silenceFrames(n: number): Buffer {
    return makePcm(samplesPerFrame * n, 0);
  }

  /** 生成 n 帧有声 PCM（幅值远超阈值）。 */
  function loudFrames(n: number): Buffer {
    return makePcm(samplesPerFrame * n, 20000);
  }

  it('静音 + 有声 + 静音 → 恰产一个 AudioActivityEvent，时间戳与帧数合理', () => {
    const vad = createVad(vadOptions);
    // 2 帧静音 + 10 帧有声 + 5 帧静音（挂起 3 帧触发结算）
    const pcm = Buffer.concat([silenceFrames(2), loudFrames(10), silenceFrames(5)]);
    const events = vad.processAudio(pcm, 0);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.startTimestamp).toBeGreaterThanOrEqual(0);
    expect(event.endTimestamp).toBeGreaterThan(event.startTimestamp);
    expect(event.durationMs).toBe(event.endTimestamp - event.startTimestamp);
    expect(event.frameCount).toBeGreaterThan(0);
  });

  it('triggerMs 未满的短促有声不触发（只有 1 帧有声，triggerMs 需 2 帧）', () => {
    const vad = createVad(vadOptions);
    const pcm = Buffer.concat([silenceFrames(2), loudFrames(1), silenceFrames(5)]);
    const events = vad.processAudio(pcm, 0);
    expect(events).toHaveLength(0);
  });

  it('minEventMs 过滤过短段', () => {
    // minEventMs 调大到 1000ms，段远达不到 → 丢弃
    const vad = createVad({ ...vadOptions, minEventMs: 1000 });
    const pcm = Buffer.concat([silenceFrames(2), loudFrames(4), silenceFrames(5)]);
    const events = vad.processAudio(pcm, 0);
    expect(events).toHaveLength(0);
  });

  it('跨 chunk 投喂同一段仍能正确切帧并结算（残留缓冲 works）', () => {
    const vad = createVad(vadOptions);
    const full = Buffer.concat([silenceFrames(2), loudFrames(10), silenceFrames(5)]);

    // 在非帧边界处切开（制造残留），分三次投喂
    const cut1 = 777;
    const cut2 = 5555;
    const part1 = full.subarray(0, cut1);
    const part2 = full.subarray(cut1, cut2);
    const part3 = full.subarray(cut2);

    const events: ReturnType<typeof vad.processAudio> = [];
    events.push(...vad.processAudio(part1, 0));
    events.push(...vad.processAudio(part2, 0));
    events.push(...vad.processAudio(part3, 0));

    expect(events).toHaveLength(1);
  });

  it('reset 后状态清空，重新从静音态开始', () => {
    const vad = createVad(vadOptions);
    const pcm = Buffer.concat([silenceFrames(2), loudFrames(10), silenceFrames(5)]);
    expect(vad.processAudio(pcm, 0)).toHaveLength(1);

    vad.reset();
    // 只投喂静音 → 无事件
    expect(vad.processAudio(silenceFrames(10), 0)).toHaveLength(0);
  });

  it('全程静音 → 无事件', () => {
    const vad = createVad(vadOptions);
    expect(vad.processAudio(silenceFrames(20), 0)).toHaveLength(0);
  });
});
