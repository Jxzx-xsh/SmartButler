/** 帧广播器单测：订阅/退订、多订阅者 fan-out、异常隔离、计数。 */

import { describe, expect, it, vi } from 'vitest';

import { createFrameBroadcaster } from './frame-broadcaster.js';

/** 一个最小 JPEG 帧占位（内容仅用于断言透传）。 */
const FRAME = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);

describe('createFrameBroadcaster', () => {
  it('addListener 后 publish 收到 (buffer, timestamp)', () => {
    const broadcaster = createFrameBroadcaster();
    const cb = vi.fn();
    broadcaster.addListener(cb);

    broadcaster.publish(FRAME, 1234);

    expect(cb).toHaveBeenCalledTimes(1);
    expect((cb.mock.calls[0]?.[0] as Buffer).equals(FRAME)).toBe(true);
    expect(cb.mock.calls[0]?.[1]).toBe(1234);
  });

  it('多订阅者都收到同一帧', () => {
    const broadcaster = createFrameBroadcaster();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    broadcaster.addListener(cb1);
    broadcaster.addListener(cb2);

    broadcaster.publish(FRAME, 7);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('removeListener 后不再收到帧', () => {
    const broadcaster = createFrameBroadcaster();
    const cb = vi.fn();
    broadcaster.addListener(cb);
    broadcaster.removeListener(cb);

    broadcaster.publish(FRAME, 1);

    expect(cb).not.toHaveBeenCalled();
  });

  it('addListener 返回的退订函数生效后不再收到帧', () => {
    const broadcaster = createFrameBroadcaster();
    const cb = vi.fn();
    const off = broadcaster.addListener(cb);
    off();

    broadcaster.publish(FRAME, 1);

    expect(cb).not.toHaveBeenCalled();
  });

  it('单订阅者抛错被隔离，后续订阅者仍收到帧', () => {
    const broadcaster = createFrameBroadcaster();
    const boom = vi.fn(() => {
      throw new Error('订阅者炸了');
    });
    const ok = vi.fn();
    broadcaster.addListener(boom);
    broadcaster.addListener(ok);

    expect(() => broadcaster.publish(FRAME, 1)).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('listenerCount 随订阅/退订变化', () => {
    const broadcaster = createFrameBroadcaster();
    expect(broadcaster.listenerCount()).toBe(0);

    const off1 = broadcaster.addListener(vi.fn());
    const cb2 = vi.fn();
    broadcaster.addListener(cb2);
    expect(broadcaster.listenerCount()).toBe(2);

    off1();
    expect(broadcaster.listenerCount()).toBe(1);

    broadcaster.removeListener(cb2);
    expect(broadcaster.listenerCount()).toBe(0);
  });
});
