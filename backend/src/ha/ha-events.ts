/**
 * Home Assistant WebSocket 事件订阅器。
 *
 * 职责：基于 ws 自实现一个最小的 HA WebSocket 客户端，完成鉴权握手、订阅
 * state_changed 事件并把事件回调给上层；断线按退避自动重连；stop() 在任意
 * 状态（连接态/重连等待态/未连接态）下都在有限时间内可靠 resolve、清理定时器
 * 与监听、不挂起。
 *
 * 握手序列（HA WebSocket API）：
 *   1. 连接后 HA 发 { type: 'auth_required' }；
 *   2. 客户端回 { type: 'auth', access_token: <token> }；
 *   3. HA 回 { type: 'auth_ok' } → 发送 { id, type: 'subscribe_events', event_type };
 *      或 HA 回 { type: 'auth_invalid' } → 令牌无效，停止且不重连；
 *   4. 之后 HA 推送 { id, type: 'event', event: {...} }，event.data 为 state_changed 数据。
 *
 * 重连：close 事件触发时若非手动 stop，则按
 *   delay = min(reconnectBaseMs * 2^reconnectAttempt, reconnectMaxMs) 退避重连。
 *
 * stop 不挂起设计（吸取 Task6 采集网关 stop 挂起教训，见
 * .agents/tasks/capture-stop-fix-review.md）：先置 stopped、清重连定时器打断重连，
 * 快照 socket 引用后立即清 null；若有 socket 则以「一次性 close 监听 或 短超时」
 * 二选一结算后 resolve；若无 socket 直接 resolve。确保连接/重连/未连接三态都干净
 * resolve，不留悬挂定时器/监听。
 *
 * 令牌安全：长期访问令牌仅出现在 auth 消息的构造处（随 config.token 读取），
 * 绝不 console.log、绝不进任何回调回显、绝不落日志。
 */

import WsWebSocket from 'ws';

import type { HaConfig } from './config.js';
import { HaError } from './errors.js';

/** HA state_changed 事件 data 结构（宽松，仅约束取用字段）。 */
export interface HaStateChangedEvent {
  entity_id?: string;
  old_state?: unknown;
  new_state?: unknown;
  [k: string]: unknown;
}

/** 订阅器事件回调集合（均为可选）。 */
export interface HaEventHandlers {
  /** 收到 state_changed 事件时回调（参数为 HA 事件对象的 event 字段内容） */
  onStateChanged?(event: HaStateChangedEvent): void;
  /** 鉴权通过、订阅已发出时回调 */
  onOpen?(): void;
  /** 连接关闭时回调 */
  onClose?(): void;
  /** 发生错误时回调（鉴权失败或底层连接错误，均为 HaError） */
  onError?(err: HaError): void;
}

/** 订阅器对外接口。 */
export interface HaEventSubscriber {
  /** 启动连接（清 stopped 标志后发起连接） */
  start(): void;
  /** 停止连接：清理重连定时器、关闭 socket，在有限时间内可靠 resolve */
  stop(): Promise<void>;
  /** 当前是否已鉴权连通 */
  isConnected(): boolean;
}

/**
 * 最小 WebSocket 接口（EventEmitter 风格，镜像 ws 包的 on(...) API）。
 * 测试注入 fake 实现即可脱离真实网络。
 */
export interface WebSocketLike {
  /** 发送文本消息 */
  send(data: string): void;
  /** 关闭连接 */
  close(): void;
  /** 监听事件：open / message / close / error */
  on(
    event: 'open' | 'message' | 'close' | 'error',
    cb: (...args: unknown[]) => void,
  ): void;
}

/** WebSocket 构造器类型：由 url 创建一个 WebSocketLike。 */
export type WebSocketCtor = (url: string) => WebSocketLike;

/** createHaEventSubscriber 依赖注入入参。 */
export interface CreateHaEventSubscriberDeps {
  /** HA 配置（提供 wsUrl / token / 重连退避 / 事件类型） */
  config: HaConfig;
  /** 事件回调集合 */
  handlers: HaEventHandlers;
  /** 注入的 WebSocket 构造器，缺省用 ws 包（测试注入 fake 脱离网络） */
  WebSocketCtor?: WebSocketCtor;
}

/** stop() 等待 close 的兜底超时（毫秒）：close 迟迟不来时强制 resolve。 */
const STOP_CLOSE_TIMEOUT_MS = 1000;

/**
 * 创建 HA WebSocket 事件订阅器。
 * @param deps 配置、回调与可选 WebSocket 构造器（测试注入 fake）。
 */
export function createHaEventSubscriber(
  deps: CreateHaEventSubscriberDeps,
): HaEventSubscriber {
  const { config, handlers } = deps;
  // 缺省用 ws 包构造真实连接；注入 fake 便于测试，镜像 lmstudio 注入范式
  const makeSocket: WebSocketCtor =
    deps.WebSocketCtor ?? ((url: string) => new WsWebSocket(url) as unknown as WebSocketLike);

  // 内部状态
  let socket: WebSocketLike | null = null;
  // 客户端消息 id：每发一条递增，首条 id=1（auth 消息本身不带 id）
  let msgId = 1;
  // 手动停止标志：为真时 close 不再触发重连
  let stopped = false;
  // 重连定时器句柄
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // 重连尝试次数（用于指数退避）
  let reconnectAttempt = 0;
  // 是否已鉴权连通
  let connected = false;

  /** 计算下一次重连延迟并排程（指数退避，封顶 reconnectMaxMs）。 */
  function scheduleReconnect(): void {
    const delay = Math.min(
      config.reconnectBaseMs * 2 ** reconnectAttempt,
      config.reconnectMaxMs,
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) {
        connect();
      }
    }, delay);
  }

  /** 处理收到的单条消息（已解析后的对象）。 */
  function handleMessage(msg: unknown): void {
    if (msg === null || typeof msg !== 'object') {
      return;
    }
    const type = (msg as { type?: unknown }).type;

    if (type === 'auth_required') {
      // 回鉴权消息：令牌仅在此处进入发送内容，绝不外泄到日志/回调
      socket?.send(JSON.stringify({ type: 'auth', access_token: config.token }));
      return;
    }

    if (type === 'auth_ok') {
      connected = true;
      reconnectAttempt = 0;
      handlers.onOpen?.();
      // 发送事件订阅请求（首条带 id 的客户端消息 id=1）
      socket?.send(
        JSON.stringify({
          id: msgId++,
          type: 'subscribe_events',
          event_type: config.stateChangedEventType,
        }),
      );
      return;
    }

    if (type === 'auth_invalid') {
      // 令牌无效：报错且不再重连（置 stopped 后主动关闭）
      handlers.onError?.(new HaError('Home Assistant 令牌无效', 'auth'));
      stopped = true;
      socket?.close();
      return;
    }

    if (type === 'event') {
      const event = (msg as { event?: unknown }).event;
      if (event !== undefined && event !== null) {
        handlers.onStateChanged?.(event as HaStateChangedEvent);
      }
      return;
    }
    // 其余类型（如 result 回执）无需处理
  }

  /** 发起一次连接并挂载事件监听。 */
  function connect(): void {
    const ws = makeSocket(config.wsUrl);
    socket = ws;

    ws.on('message', (...args: unknown[]) => {
      // ws 的 message 事件首参为数据（Buffer/string/ArrayBuffer），转字符串后解析 JSON
      const raw = args[0];
      let text: string;
      if (typeof raw === 'string') {
        text = raw;
      } else if (raw instanceof Buffer) {
        text = raw.toString('utf8');
      } else {
        text = String(raw);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // 非 JSON 消息忽略（不回显内容）
        return;
      }
      handleMessage(parsed);
    });

    ws.on('close', () => {
      connected = false;
      // 关闭后清掉当前 socket 引用：使重连等待态下 stop() 的快照为空、立即 resolve
      // （吸取 Task6 教训：等待集为空统一走立即结算，不依赖一次性 close 事件）
      if (socket === ws) {
        socket = null;
      }
      handlers.onClose?.();
      // 非手动停止才排程重连
      if (!stopped) {
        scheduleReconnect();
      }
    });

    ws.on('error', (...args: unknown[]) => {
      // 底层连接错误：包装为 HaError 回调（不重复触发重连，重连交由随后的 close 处理）
      const cause = args[0];
      handlers.onError?.(new HaError('Home Assistant WebSocket 错误', 'connection', cause));
    });
  }

  function start(): void {
    stopped = false;
    connect();
  }

  function isConnected(): boolean {
    return connected;
  }

  /**
   * 停止订阅。先切断重连（置 stopped、清定时器），再快照 socket 并立即清 null，
   * 保证后续 close/error 回调与再次 stop 都看不到活跃 socket。
   * 对存活 socket 以「一次性 close 或短超时」二选一结算后 resolve；无 socket 直接 resolve。
   */
  function stop(): Promise<void> {
    // 第一步：切断重连
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connected = false;

    // 快照后立即清引用：reconnecting 等待态此时 socket 可能已为 null → 空等待集
    const target = socket;
    socket = null;

    if (target === null) {
      // 未连接 / 重连等待态：无活跃 socket，直接 resolve
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      // 二选一结算：close 到来 或 短超时兜底
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve();
      };

      const timer: ReturnType<typeof setTimeout> | null = setTimeout(
        finish,
        STOP_CLOSE_TIMEOUT_MS,
      );

      // 注册一次性 close 监听（on 语义下用 settled 保证只结算一次）
      target.on('close', () => {
        finish();
      });

      // 主动关闭（可能同步/异步触发上面的 close）
      try {
        target.close();
      } catch {
        // 关闭异常不阻断结算，交给超时兜底或已触发的 close
      }
    });
  }

  return { start, stop, isConnected };
}
