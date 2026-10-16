/**
 * HA WebSocket 事件订阅器单元测试。
 *
 * 全程注入 fake WebSocket（EventEmitter 风格 on()，记录 send 内容、暴露手动触发
 * open/message/close/error 的方法），绝不触真实网络。用 vi.useFakeTimers() 控制重连。
 * 覆盖：握手序列、消息 id 递增、auth_invalid 不重连、event 回调、断线退避重连、
 * stop() 在连接/重连/未连接三态均可靠 resolve。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadHaConfig, type HaConfig } from './config.js';
import { HaError } from './errors.js';
import {
  createHaEventSubscriber,
  type HaEventHandlers,
  type WebSocketLike,
} from './ha-events.js';

/** fake WebSocket：记录发送内容、暴露手动触发事件的方法。 */
class FakeWebSocket implements WebSocketLike {
  /** 构造时传入的 url */
  readonly url: string;
  /** 记录所有 send 的原始字符串 */
  readonly sent: string[] = [];
  /** close 是否被调用 */
  closed = false;
  /** 各事件的监听器集合 */
  private readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    // 真实 ws close 后会异步 emit 'close'；此处交由测试显式 emitClose 控制时序
  }

  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: unknown[]) => void): void {
    this.listeners[event]?.push(cb);
  }

  /** 手动触发某事件 */
  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners[event] ?? []) {
      cb(...args);
    }
  }

  emitOpen(): void {
    this.emit('open');
  }

  /** 以对象形式触发 message（内部 JSON.stringify） */
  emitMessage(obj: unknown): void {
    this.emit('message', JSON.stringify(obj));
  }

  emitClose(): void {
    this.emit('close');
  }

  emitError(err: unknown): void {
    this.emit('error', err);
  }

  /** 已发送消息解析为对象数组 */
  sentObjects(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const TOKEN = 'test-long-lived-token-xyz';

/** 构造带固定 token 的测试配置。 */
function makeConfig(): HaConfig {
  return loadHaConfig({
    HA_BASE_URL: 'http://ha.test:8123',
    HA_TOKEN: TOKEN,
    HA_WS_RECONNECT_BASE_MS: '1000',
    HA_WS_RECONNECT_MAX_MS: '30000',
  } as NodeJS.ProcessEnv);
}

/** 创建订阅器 + fake 工厂：返回订阅器、handlers spy、获取最近 socket 的函数。 */
function setup(handlers: HaEventHandlers = {}) {
  const sockets: FakeWebSocket[] = [];
  const subscriber = createHaEventSubscriber({
    config: makeConfig(),
    handlers,
    WebSocketCtor: (url: string) => {
      const ws = new FakeWebSocket(url);
      sockets.push(ws);
      return ws;
    },
  });
  return {
    subscriber,
    sockets,
    last: () => sockets[sockets.length - 1] as FakeWebSocket,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('握手序列', () => {
  it('auth_required → 发送 auth（含 token）→ auth_ok → onOpen 且发送 subscribe_events(id=1)', () => {
    const onOpen = vi.fn();
    const { subscriber, last } = setup({ onOpen });
    subscriber.start();
    const ws = last();

    // 收 auth_required → 回 auth
    ws.emitMessage({ type: 'auth_required' });
    const authMsg = ws.sentObjects()[0];
    expect(authMsg).toEqual({ type: 'auth', access_token: TOKEN });

    // 收 auth_ok → onOpen + 订阅
    ws.emitMessage({ type: 'auth_ok' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(subscriber.isConnected()).toBe(true);

    const subMsg = ws.sentObjects()[1];
    expect(subMsg).toEqual({ id: 1, type: 'subscribe_events', event_type: 'state_changed' });

    // token 只出现在 auth 消息里，不在订阅消息里
    expect(JSON.stringify(subMsg)).not.toContain(TOKEN);
  });

  it('auth_invalid → onError 收到 HaError kind=auth 且不排程重连', () => {
    const onError = vi.fn();
    const { subscriber, sockets, last } = setup({ onError });
    subscriber.start();
    const ws = last();

    ws.emitMessage({ type: 'auth_invalid' });
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as HaError;
    expect(err).toBeInstanceOf(HaError);
    expect(err.kind).toBe('auth');
    expect(ws.closed).toBe(true);

    // auth_invalid 后即便 close 触发，也不重连（stopped=true）
    ws.emitClose();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });
});

describe('消息 id 递增', () => {
  it('多条带 id 的客户端消息 id 严格 +1（首条 1）', () => {
    const { subscriber, last } = setup();
    subscriber.start();
    const ws = last();

    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });
    // 首个带 id 消息为订阅，id=1
    expect((ws.sentObjects()[1] as { id: number }).id).toBe(1);

    // 模拟一次重连后重新 auth_ok：id 应继续递增到 2
    ws.emitClose();
    vi.advanceTimersByTime(1000);
    const ws2 = last();
    ws2.emitMessage({ type: 'auth_required' });
    ws2.emitMessage({ type: 'auth_ok' });
    const sub2 = ws2.sentObjects().find((m) => m.type === 'subscribe_events') as { id: number };
    expect(sub2.id).toBe(2);
  });
});

describe('event 消息', () => {
  it('收 event → onStateChanged 收到 event.event', () => {
    const onStateChanged = vi.fn();
    const { subscriber, last } = setup({ onStateChanged });
    subscriber.start();
    const ws = last();

    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });

    const eventData = { entity_id: 'light.kitchen', new_state: { state: 'on' } };
    ws.emitMessage({ id: 1, type: 'event', event: eventData });

    expect(onStateChanged).toHaveBeenCalledTimes(1);
    expect(onStateChanged.mock.calls[0]?.[0]).toEqual(eventData);
  });
});

describe('断线重连', () => {
  it('非 stopped 的 close 后按退避触发重连并重新握手', () => {
    const { subscriber, sockets, last } = setup();
    subscriber.start();
    const ws = last();

    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });
    expect(sockets).toHaveLength(1);

    // 断线：第一次重连延迟 = base * 2^0 = 1000ms
    ws.emitClose();
    expect(subscriber.isConnected()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // 新连接可重新握手
    const ws2 = last();
    ws2.emitMessage({ type: 'auth_required' });
    expect(ws2.sentObjects()[0]).toEqual({ type: 'auth', access_token: TOKEN });

    // 退避递增：auth_ok 前再断一次应用 base * 2^1 = 2000ms
    ws2.emitClose();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('auth_ok 后 reconnectAttempt 归零（下次断线又从 1000ms 起）', () => {
    const { subscriber, sockets, last } = setup();
    subscriber.start();

    // 第一次断线累积退避
    last().emitClose();
    vi.advanceTimersByTime(1000); // attempt 0 → 1000
    expect(sockets).toHaveLength(2);

    // 本次握手成功 → attempt 归零
    const ws2 = last();
    ws2.emitMessage({ type: 'auth_required' });
    ws2.emitMessage({ type: 'auth_ok' });

    // 再断线应又是 1000ms（而非 2000ms）
    ws2.emitClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);
  });
});

describe('stop 不挂起', () => {
  it('连接态 await stop() 可靠 resolve（close 触发）', async () => {
    const { subscriber, last } = setup();
    subscriber.start();
    const ws = last();
    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });

    // close() 内不自动 emit，用微任务模拟异步 close 到来
    const p = subscriber.stop();
    expect(ws.closed).toBe(true);
    ws.emitClose();
    await expect(p).resolves.toBeUndefined();
    expect(subscriber.isConnected()).toBe(false);
  });

  it('连接态 stop() 在 close 不来时由超时兜底 resolve', async () => {
    const { subscriber, last } = setup();
    subscriber.start();
    const ws = last();
    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });

    const p = subscriber.stop();
    // 不 emit close，推进到超时兜底
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it('重连等待态 stop() 清定时器并立即 resolve，之后不再重连', async () => {
    const { subscriber, sockets, last } = setup();
    subscriber.start();
    // 进入重连等待态
    last().emitClose();
    expect(sockets).toHaveLength(1);

    // 此时 socket 已为 null（close 后未重连），stop 走空等待集立即 resolve
    await expect(subscriber.stop()).resolves.toBeUndefined();

    // stop 后定时器被清，推进时间不再新建连接
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });

  it('未连接态 stop() 直接 resolve', async () => {
    const { subscriber } = setup();
    // 从未 start
    await expect(subscriber.stop()).resolves.toBeUndefined();
  });

  it('stop 后迟到的 close 不触发重连', async () => {
    const { subscriber, sockets, last } = setup();
    subscriber.start();
    const ws = last();
    ws.emitMessage({ type: 'auth_required' });
    ws.emitMessage({ type: 'auth_ok' });

    const p = subscriber.stop();
    ws.emitClose();
    await p;

    // 迟到的 close 已在 stop 时触发；再推进时间不应重连
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });
});
