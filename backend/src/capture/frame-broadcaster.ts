/**
 * 帧广播器（FrameBroadcaster）。
 *
 * 职责：把采集网关的「单回调 onFrame」解耦成「多订阅广播」，让门控
 * processFrame 与 HTTP stream 订阅者共享同一帧源，彼此互不干扰。
 *
 * 设计理由：
 * - 网关构造时只接受一个 onFrame 单回调（固化在工厂闭包），不便多路分发。
 *   故不改 gateway.ts，而是在 server.ts 侧把广播器的 publish 接到网关唯一的
 *   onFrame 上，由广播器再 fan-out 给各订阅者。这样网关契约零改动。
 * - publish 逐个订阅者 try/catch 调用：单个订阅者（如某个断开中的 stream）
 *   抛错不会波及其他订阅者，更不会冒泡回网关回调链、影响门控每帧处理。
 * - addListener 返回退订函数，便于 stream 连接关闭时就地清理，避免泄漏。
 */

/** 帧订阅回调：收到一帧 JPEG Buffer 与其时间戳（ms）。 */
export type FrameListener = (buffer: Buffer, timestamp: number) => void;

/** 帧广播器接口：publish 下发、addListener/removeListener 订阅管理。 */
export interface FrameBroadcaster {
  /** 下发一帧给所有订阅者（逐个 try/catch，单订阅者抛错被隔离）。 */
  publish(buffer: Buffer, timestamp: number): void;
  /** 新增订阅者，返回退订函数（调用后不再收到帧）。 */
  addListener(cb: FrameListener): () => void;
  /** 移除订阅者（未订阅则无副作用）。 */
  removeListener(cb: FrameListener): void;
  /** 当前订阅者数量。 */
  listenerCount(): number;
}

/**
 * 构造一个帧广播器：内部用订阅者数组维护全部监听。
 *
 * publish 遍历订阅者逐个 try/catch 调用，保证单订阅者异常被隔离，后续订阅者
 * 与门控仍正常收到帧；addListener 返回的退订函数等价于 removeListener(cb)。
 */
export function createFrameBroadcaster(): FrameBroadcaster {
  // 订阅者列表：addListener 追加、removeListener 按引用剔除
  const listeners: FrameListener[] = [];

  return {
    publish(buffer: Buffer, timestamp: number): void {
      // 遍历快照副本：即使某订阅者在回调里退订，也不影响本轮遍历
      for (const cb of [...listeners]) {
        try {
          cb(buffer, timestamp);
        } catch {
          // 单订阅者抛错被隔离：不影响其他订阅者，也不冒泡回网关/门控
        }
      }
    },
    addListener(cb: FrameListener): () => void {
      listeners.push(cb);
      // 退订函数：按引用移除本次订阅（重复调用安全，第二次 indexOf 为 -1）
      return () => {
        const index = listeners.indexOf(cb);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
    },
    removeListener(cb: FrameListener): void {
      const index = listeners.indexOf(cb);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
    listenerCount(): number {
      return listeners.length;
    },
  };
}
