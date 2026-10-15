/** 门控协调器单测（注入 fake motionDetector / fake vad，断言事件派发与指标） */

import { describe, expect, it, vi } from 'vitest';

import { createGatingController } from './gating.js';
import type { MotionDetector, MotionEvent } from './motion.js';
import type { AudioActivityEvent, Vad } from './vad.js';

/** 等待微任务队列清空，确保 processFrame 内部异步链结算完成。 */
async function flushMicrotasks(): Promise<void> {
  // 多次 await 让挂在 Promise 链尾的处理有机会全部跑完
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** 构造一个按预设结果返回的 fake motionDetector。 */
function makeFakeMotion(
  processFrame: MotionDetector['processFrame'],
): MotionDetector {
  return {
    processFrame,
    reset: vi.fn(),
  };
}

/** 构造一个按预设事件返回的 fake vad。 */
function makeFakeVad(
  processAudio: Vad['processAudio'],
  extra: Partial<Vad> = {},
): Vad {
  return {
    processAudio,
    reset: vi.fn(),
    ...extra,
  };
}

/** 便捷构造一个 MotionEvent。 */
function makeMotionEvent(overrides: Partial<MotionEvent> = {}): MotionEvent {
  return {
    timestamp: 1000,
    changedRatio: 0.5,
    mad: 20,
    frame: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    ...overrides,
  };
}

describe('createGatingController 视频运动', () => {
  it('命中时订阅者收到带 frame 的 VideoMotionEvent 且指标正确', async () => {
    const frame = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
    const event = makeMotionEvent({ timestamp: 1234, changedRatio: 0.3, frame });
    const motionDetector = makeFakeMotion(vi.fn().mockResolvedValue(event));
    const vad = makeFakeVad(vi.fn().mockReturnValue([]));
    const controller = createGatingController({ motionDetector, vad });

    const received: Array<{ timestamp: number; changedRatio: number; frame: Buffer }> = [];
    controller.onVideoMotion((e) => received.push(e));

    controller.processFrame(frame, 1234);
    await flushMicrotasks();

    expect(received).toHaveLength(1);
    expect(received[0]?.timestamp).toBe(1234);
    expect(received[0]?.changedRatio).toBe(0.3);
    // frame 为同一引用透传
    expect(received[0]?.frame).toBe(frame);

    const stats = controller.getStats();
    expect(stats.framesProcessed).toBe(1);
    expect(stats.motionEvents).toBe(1);
    expect(stats.lastMotionAt).toBe(1234);
  });

  it('未命中（返回 null）不派发事件，framesProcessed 仍累加', async () => {
    const motionDetector = makeFakeMotion(vi.fn().mockResolvedValue(null));
    const vad = makeFakeVad(vi.fn().mockReturnValue([]));
    const controller = createGatingController({ motionDetector, vad });

    const spy = vi.fn();
    controller.onVideoMotion(spy);

    controller.processFrame(Buffer.from([0x01]), 10);
    controller.processFrame(Buffer.from([0x02]), 20);
    await flushMicrotasks();

    expect(spy).not.toHaveBeenCalled();
    const stats = controller.getStats();
    expect(stats.framesProcessed).toBe(2);
    expect(stats.motionEvents).toBe(0);
    expect(stats.lastMotionAt).toBeNull();
  });

  it('多次异步 processFrame 的事件派发顺序与投喂顺序一致（串行链）', async () => {
    // 让不同帧的解码耗时不同（先投喂的更慢），验证串行链仍按投喂顺序派发
    const order: number[] = [];
    const motionDetector = makeFakeMotion(
      vi.fn(async (jpeg: Buffer, ts: number): Promise<MotionEvent | null> => {
        // 第一帧延迟更久，若并发会导致顺序颠倒
        const delay = ts === 1 ? 20 : 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return makeMotionEvent({ timestamp: ts });
      }),
    );
    const vad = makeFakeVad(vi.fn().mockReturnValue([]));
    const controller = createGatingController({ motionDetector, vad });

    controller.onVideoMotion((e) => order.push(e.timestamp));

    controller.processFrame(Buffer.from([0x01]), 1);
    controller.processFrame(Buffer.from([0x02]), 2);
    controller.processFrame(Buffer.from([0x03]), 3);

    // 等待串行链全部结算（含 setTimeout）
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(order).toEqual([1, 2, 3]);
    expect(controller.getStats().motionEvents).toBe(3);
  });

  it('motionDetector 解码抛错时走 onError 且不中断后续帧', async () => {
    const calls: number[] = [];
    const motionDetector = makeFakeMotion(
      vi.fn(async (jpeg: Buffer, ts: number): Promise<MotionEvent | null> => {
        calls.push(ts);
        if (ts === 1) {
          throw new Error('解码失败');
        }
        return makeMotionEvent({ timestamp: ts });
      }),
    );
    const vad = makeFakeVad(vi.fn().mockReturnValue([]));
    const onError = vi.fn();
    const controller = createGatingController({ motionDetector, vad, onError });

    const received: number[] = [];
    controller.onVideoMotion((e) => received.push(e.timestamp));

    controller.processFrame(Buffer.from([0x01]), 1);
    controller.processFrame(Buffer.from([0x02]), 2);
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // 第一帧抛错不中断后续帧
    expect(calls).toEqual([1, 2]);
    expect(received).toEqual([2]);
    expect(controller.getStats().motionEvents).toBe(1);
  });
});

describe('createGatingController 音频活动', () => {
  it('多事件时订阅者逐个收到，指标累加', () => {
    const events: AudioActivityEvent[] = [
      { startTimestamp: 0, endTimestamp: 500, durationMs: 500, frameCount: 25 },
      { startTimestamp: 600, endTimestamp: 1200, durationMs: 600, frameCount: 30 },
    ];
    const vad = makeFakeVad(vi.fn().mockReturnValue(events));
    const motionDetector = makeFakeMotion(vi.fn().mockResolvedValue(null));
    const controller = createGatingController({ motionDetector, vad });

    const received: AudioActivityEvent[] = [];
    controller.onAudioActivity((e) => received.push(e));

    const pcm = Buffer.alloc(640); // 任意长度
    controller.processAudio(pcm, 0);

    expect(received).toHaveLength(2);
    expect(received[0]?.endTimestamp).toBe(500);
    expect(received[1]?.endTimestamp).toBe(1200);

    const stats = controller.getStats();
    expect(stats.audioEvents).toBe(2);
    expect(stats.audioBytesProcessed).toBe(640);
    expect(stats.lastAudioAt).toBe(1200);
  });

  it('vad 暴露 isSpeaking() 时 speaking 随之切换', () => {
    let speakingState = true;
    const vad = makeFakeVad(vi.fn().mockReturnValue([]), {
      isSpeaking: () => speakingState,
    } as Partial<Vad>);
    const motionDetector = makeFakeMotion(vi.fn().mockResolvedValue(null));
    const controller = createGatingController({ motionDetector, vad });

    controller.processAudio(Buffer.alloc(320), 0);
    expect(controller.getStats().speaking).toBe(true);

    speakingState = false;
    controller.processAudio(Buffer.alloc(320), 100);
    expect(controller.getStats().speaking).toBe(false);
  });

  it('vad 无 isSpeaking() 时产出事件后 speaking 回到 false', () => {
    const events: AudioActivityEvent[] = [
      { startTimestamp: 0, endTimestamp: 500, durationMs: 500, frameCount: 25 },
    ];
    const vad = makeFakeVad(vi.fn().mockReturnValue(events));
    const motionDetector = makeFakeMotion(vi.fn().mockResolvedValue(null));
    const controller = createGatingController({ motionDetector, vad });

    controller.processAudio(Buffer.alloc(640), 0);
    expect(controller.getStats().speaking).toBe(false);
  });
});
