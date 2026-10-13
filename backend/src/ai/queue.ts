/**
 * AI 任务队列调度器（手写，不引入 p-queue）。
 *
 * 为什么手写而不用 p-queue：
 *   1. 需求很窄——并发度恒为 1 的串行执行、两级优先级（immediate 优先于 deferred）、
 *      仅对可重试错误做有限次退避、以及空闲时批量拉取延后任务；
 *   2. p-queue 的优先级是数值权重且不区分「清空高优先级再取低优先级」这种硬约束，
 *      还要再包一层才能满足；相比之下自己维护两个数组 + 单一 running 标志更直观、
 *      依赖更少、更易用 fakeTimers 做确定性测试；
 *   3. 本任务明确要求不新增 p-queue 依赖。
 *
 * 调度不变量：
 *   - 任意时刻最多只有一个任务在 run（并发度 = 1，running 标志保证）；
 *   - 取下一个任务时严格先清空 immediateQ 再取 deferredQ，不抢占正在执行的任务；
 *   - enqueue* 返回的 Promise 在任务最终成功时 resolve、最终失败时 reject。
 */

import type { LmStudioClient } from './lmstudio.js';
import { isRetryable } from './errors.js';
import type { AppDatabase } from '../db/client.js';
import { eventLogs } from '../db/schema.js';

/** 任务优先级：immediate（即时，优先）/ deferred（延后，空闲批处理）。 */
export type AiTaskPriority = 'immediate' | 'deferred';

/** 一个待调度的 AI 任务。 */
export interface AiQueueTask<T> {
  /** 可选任务标识，便于日志/排查；缺省时自动生成 */
  id?: string;
  /** 实际执行体，返回 Promise */
  run: () => Promise<T>;
  /** 可选元数据，透传进事件便于观测 */
  meta?: Record<string, unknown>;
}

/** 队列可观测事件。 */
export interface AiQueueEvent {
  /** 事件类型：开始 / 成功 / 失败（最终）/ 重试（本次失败将再试） */
  type: 'start' | 'success' | 'failure' | 'retry';
  /** 任务标识 */
  taskId: string;
  /** 任务优先级 */
  priority: AiTaskPriority;
  /** 第几次尝试，从 1 开始 */
  attempt: number;
  /** 关联错误（failure/retry 时存在） */
  error?: unknown;
  /** 任务元数据 */
  meta?: Record<string, unknown>;
}

/** 重试策略。 */
export interface AiQueueRetryOptions {
  /** 最大重试次数（不含首次执行）；0 表示不重试 */
  maxRetries: number;
  /** 每次重试前的退避等待毫秒 */
  backoffMs: number;
}

/** createAiQueue 选项。 */
export interface CreateAiQueueOptions {
  /** LM Studio 客户端；队列本身不直接调用，仅透传给需要的任务工厂/消费方 */
  client?: LmStudioClient;
  /** 数据库实例；提供时把任务事件写入 event_log（失败不影响主流程） */
  db?: AppDatabase;
  /** 重试策略，缺省不重试 */
  retry?: AiQueueRetryOptions;
  /** 空闲判定毫秒：immediate 队列持续为空达到该时长后触发批处理，默认 1000 */
  idleMs?: number;
  /** 每批从 deferredSource 拉取的最大任务数，默认 5 */
  batchSize?: number;
  /** 延后任务来源：空闲时调用以拉取一批延后任务 */
  deferredSource?: () => Promise<Array<AiQueueTask<unknown>>>;
  /** 事件回调 */
  onEvent?: (event: AiQueueEvent) => void;
}

/** 队列对外句柄。 */
export interface AiQueue {
  /** 入队一个即时任务，返回其执行结果 Promise */
  enqueueImmediate<T>(task: AiQueueTask<T>): Promise<T>;
  /** 入队一个延后任务，返回其执行结果 Promise */
  enqueueDeferred<T>(task: AiQueueTask<T>): Promise<T>;
  /** 启动空闲批处理定时器 */
  start(): void;
  /** 停止空闲批处理定时器 */
  stop(): void;
  /** 当前两级队列积压数量 */
  size(): { immediate: number; deferred: number };
}

/** 队列内部条目：任务 + 其 resolve/reject + 优先级。 */
interface QueueEntry {
  id: string;
  priority: AiTaskPriority;
  run: () => Promise<unknown>;
  meta?: Record<string, unknown> | undefined;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** 默认重试策略：不重试。 */
const DEFAULT_RETRY: AiQueueRetryOptions = { maxRetries: 0, backoffMs: 0 };
/** 默认空闲判定毫秒。 */
const DEFAULT_IDLE_MS = 1000;
/** 默认每批拉取数。 */
const DEFAULT_BATCH_SIZE = 5;

/** 基于 setTimeout 的 sleep，便于 vi.useFakeTimers 推进。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 创建 AI 任务队列。
 * @param opts 可选配置，见 CreateAiQueueOptions。
 */
export function createAiQueue(opts: CreateAiQueueOptions = {}): AiQueue {
  const retry = opts.retry ?? DEFAULT_RETRY;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const { db, deferredSource, onEvent } = opts;

  // 两级队列：严格先清空 immediate 再取 deferred
  const immediateQ: QueueEntry[] = [];
  const deferredQ: QueueEntry[] = [];
  // 并发度 = 1 的核心：同一时刻只允许一个任务在跑
  let running = false;
  // 自增序号用于默认任务 id
  let seq = 0;
  // 空闲批处理定时器句柄
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  // 正在从 deferredSource 拉取标志，避免并发拉取
  let pulling = false;

  /** 派发一次事件：先 onEvent 回调，再（若注入 db）落库，落库失败吞掉不影响主流程。 */
  function emit(event: AiQueueEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // 观测回调异常不影响调度
    }
    if (db) {
      try {
        db.insert(eventLogs)
          .values({
            eventType: 'ai_task',
            payload: JSON.stringify({
              type: event.type,
              taskId: event.taskId,
              priority: event.priority,
              attempt: event.attempt,
              ...(event.error !== undefined
                ? { error: errorToPlain(event.error) }
                : {}),
              ...(event.meta !== undefined ? { meta: event.meta } : {}),
            }),
            source: 'ai-queue',
          })
          .run();
      } catch {
        // 日志落库失败不影响主流程
      }
    }
  }

  /** 把错误收敛成可 JSON 序列化的朴素结构。 */
  function errorToPlain(err: unknown): unknown {
    if (err instanceof Error) {
      const kind = (err as { kind?: unknown }).kind;
      return {
        name: err.name,
        message: err.message,
        ...(kind !== undefined ? { kind } : {}),
      };
    }
    return err;
  }

  /** 取下一个待执行条目：先 immediate 后 deferred。 */
  function takeNext(): QueueEntry | undefined {
    return immediateQ.shift() ?? deferredQ.shift();
  }

  /** 执行单个条目（含重试），结果 settle 到其 resolve/reject。 */
  async function execEntry(entry: QueueEntry): Promise<void> {
    let attempt = 0;
    // 首次 + 最多 maxRetries 次重试
    for (;;) {
      attempt += 1;
      emit({
        type: 'start',
        taskId: entry.id,
        priority: entry.priority,
        attempt,
        meta: entry.meta,
      });
      try {
        const value = await entry.run();
        emit({
          type: 'success',
          taskId: entry.id,
          priority: entry.priority,
          attempt,
          meta: entry.meta,
        });
        entry.resolve(value);
        return;
      } catch (err) {
        // 仅对可重试错误且未超限时重试，否则最终失败
        const canRetry = isRetryable(err) && attempt <= retry.maxRetries;
        if (canRetry) {
          emit({
            type: 'retry',
            taskId: entry.id,
            priority: entry.priority,
            attempt,
            error: err,
            meta: entry.meta,
          });
          if (retry.backoffMs > 0) {
            await sleep(retry.backoffMs);
          }
          continue;
        }
        emit({
          type: 'failure',
          taskId: entry.id,
          priority: entry.priority,
          attempt,
          error: err,
          meta: entry.meta,
        });
        entry.reject(err);
        return;
      }
    }
  }

  /** 调度循环：持续取任务串行执行，直到两级队列清空。 */
  async function drain(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      for (;;) {
        const entry = takeNext();
        if (!entry) {
          break;
        }
        await execEntry(entry);
      }
    } finally {
      running = false;
    }
  }

  /** 把任务包成条目入队并触发调度，返回其结果 Promise。 */
  function enqueue<T>(task: AiQueueTask<T>, priority: AiTaskPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        id: task.id ?? `ai-${priority}-${(seq += 1)}`,
        priority,
        run: task.run as () => Promise<unknown>,
        meta: task.meta,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (priority === 'immediate') {
        immediateQ.push(entry);
      } else {
        deferredQ.push(entry);
      }
      // 不等待：触发调度循环（已在跑则忽略）
      void drain();
    });
  }

  /** 空闲检查：immediate 为空且无任务在跑时，从 deferredSource 拉取一批。 */
  async function pullDeferredIfIdle(): Promise<void> {
    if (!deferredSource || pulling) {
      return;
    }
    // 仅当没有积压的 immediate 任务、且当前没有任务在执行时才算空闲
    if (immediateQ.length > 0 || running) {
      return;
    }
    pulling = true;
    try {
      const tasks = await deferredSource();
      for (const task of tasks.slice(0, batchSize)) {
        // 拉取到的延后任务入队执行；忽略其结果 Promise（失败已在事件中体现）
        void enqueueDeferred(task).catch(() => {
          // 批处理任务失败不影响拉取循环
        });
      }
    } catch {
      // 拉取失败静默，等待下个周期重试
    } finally {
      pulling = false;
    }
  }

  function enqueueImmediate<T>(task: AiQueueTask<T>): Promise<T> {
    return enqueue(task, 'immediate');
  }

  function enqueueDeferred<T>(task: AiQueueTask<T>): Promise<T> {
    return enqueue(task, 'deferred');
  }

  function start(): void {
    if (idleTimer !== undefined) {
      return;
    }
    // 用标准 setInterval 周期检查空闲，便于 vi.useFakeTimers 控制
    idleTimer = setInterval(() => {
      void pullDeferredIfIdle();
    }, idleMs);
  }

  function stop(): void {
    if (idleTimer !== undefined) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  }

  function size(): { immediate: number; deferred: number } {
    return { immediate: immediateQ.length, deferred: deferredQ.length };
  }

  return {
    enqueueImmediate,
    enqueueDeferred,
    start,
    stop,
    size,
  };
}
