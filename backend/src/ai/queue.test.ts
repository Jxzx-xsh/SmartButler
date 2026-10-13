/** AI 任务队列调度器单元测试（vitest + fakeTimers） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAiQueue, type AiQueueEvent } from './queue.js';
import { LmStudioError } from './errors.js';

/** 创建一个可控的异步任务：调用返回 { run, resolve, reject }。 */
function deferredRun<T>(): {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { run: () => promise, resolve, reject };
}

describe('createAiQueue 串行与优先级', () => {
  it('并发度恒为 1：同一时刻至多一个任务在执行', async () => {
    let active = 0;
    let maxActive = 0;
    const queue = createAiQueue();

    const makeTask = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // 让出一个微任务周期模拟异步
      await Promise.resolve();
      active -= 1;
      return 'ok';
    };

    await Promise.all([
      queue.enqueueImmediate({ run: makeTask() }),
      queue.enqueueImmediate({ run: makeTask() }),
      queue.enqueueDeferred({ run: makeTask() }),
    ]);

    expect(maxActive).toBe(1);
  });

  it('immediate 严格优先于 deferred 出队', async () => {
    const order: string[] = [];
    const queue = createAiQueue();

    // 先放一个占位任务阻塞调度，等后续任务都入队后再放行
    const gate = deferredRun<void>();
    const gatePromise = queue.enqueueImmediate({
      id: 'gate',
      run: async () => {
        order.push('gate');
        await gate.run();
      },
    });

    // 在 gate 执行期间入队：先 deferred 再 immediate
    const dPromise = queue.enqueueDeferred({
      id: 'd1',
      run: async () => {
        order.push('d1');
      },
    });
    const iPromise = queue.enqueueImmediate({
      id: 'i1',
      run: async () => {
        order.push('i1');
      },
    });

    // 放行 gate，让调度继续
    gate.resolve();
    await Promise.all([gatePromise, dPromise, iPromise]);

    // immediate(i1) 应先于 deferred(d1)
    expect(order).toEqual(['gate', 'i1', 'd1']);
  });

  it('enqueue 返回的 Promise 正确 resolve / reject', async () => {
    const queue = createAiQueue();

    await expect(
      queue.enqueueImmediate({ run: async () => 42 }),
    ).resolves.toBe(42);

    await expect(
      queue.enqueueImmediate({
        run: async () => {
          throw new LmStudioError('坏响应', 'bad_response');
        },
      }),
    ).rejects.toBeInstanceOf(LmStudioError);
  });
});

describe('createAiQueue 重试分类', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('可重试错误（timeout）退避后重试直到成功', async () => {
    const events: AiQueueEvent[] = [];
    const queue = createAiQueue({
      retry: { maxRetries: 3, backoffMs: 100 },
      onEvent: (e) => events.push(e),
    });

    let calls = 0;
    const resultPromise = queue.enqueueImmediate({
      id: 't1',
      run: async () => {
        calls += 1;
        if (calls < 3) {
          throw new LmStudioError('超时', 'timeout');
        }
        return 'done';
      },
    });

    // 推进假时钟并反复 flush microtask，让退避 sleep 结束、后续尝试运行
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toBe('done');
    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(events.some((e) => e.type === 'success')).toBe(true);
  });

  it('可重试错误超过 maxRetries 后最终 reject', async () => {
    const events: AiQueueEvent[] = [];
    const queue = createAiQueue({
      retry: { maxRetries: 2, backoffMs: 50 },
      onEvent: (e) => events.push(e),
    });

    let calls = 0;
    const resultPromise = queue.enqueueImmediate({
      id: 't2',
      run: async () => {
        calls += 1;
        throw new LmStudioError('连接失败', 'connection');
      },
    });
    // 预先挂一个 catch，避免 unhandled rejection
    const settled = resultPromise.then(
      () => 'resolved',
      () => 'rejected',
    );

    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe('rejected');
    // 首次 + 2 次重试 = 3 次调用
    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(events.some((e) => e.type === 'failure')).toBe(true);
  });

  it('不可重试错误（bad_response）立即 reject 且不重试', async () => {
    const events: AiQueueEvent[] = [];
    const queue = createAiQueue({
      retry: { maxRetries: 3, backoffMs: 50 },
      onEvent: (e) => events.push(e),
    });

    let calls = 0;
    const resultPromise = queue.enqueueImmediate({
      id: 't3',
      run: async () => {
        calls += 1;
        throw new LmStudioError('坏响应', 'bad_response');
      },
    });
    const settled = resultPromise.then(
      () => 'resolved',
      () => 'rejected',
    );

    await vi.runAllTimersAsync();

    await expect(settled).resolves.toBe('rejected');
    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(0);
  });
});

describe('createAiQueue 空闲批处理', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start 后空闲达 idleMs 调用 deferredSource 拉取一批', async () => {
    const ran: string[] = [];
    // 准备 7 个延后任务，batchSize=5 应只取前 5 个
    const deferredSource = vi.fn().mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({
        id: `d${i}`,
        run: async () => {
          ran.push(`d${i}`);
        },
      })),
    );

    const queue = createAiQueue({
      idleMs: 1000,
      batchSize: 5,
      deferredSource,
    });
    queue.start();

    // 推进一个空闲周期触发拉取，并 flush 任务执行
    await vi.advanceTimersByTimeAsync(1000);

    queue.stop();

    expect(deferredSource).toHaveBeenCalledTimes(1);
    expect(ran).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
  });

  it('stop 后不再触发 deferredSource', async () => {
    const deferredSource = vi.fn().mockResolvedValue([]);
    const queue = createAiQueue({ idleMs: 500, deferredSource });
    queue.start();
    queue.stop();

    await vi.advanceTimersByTimeAsync(2000);

    expect(deferredSource).not.toHaveBeenCalled();
  });
});
