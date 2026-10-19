/**
 * 主动到期提醒调度器。
 *
 * 职责：按可配置间隔定时检查临期物品（复用 listExpiringItems），
 * - HA 已配置时额外把临期统计暴露到 HA 传感器（复用 exposeExpiringToHa）；
 * - 无论 HA 是否配置/成功，只要有临期物品就落一条 eventLog(source='reminder')。
 *
 * 设计要点：
 * - 依赖注入 db/haClient/haConfig/config/now，便于测试用 vi.useFakeTimers + 固定 now；
 * - HA 暴露失败不抛、不影响后续落库（try/catch 吞错）；
 * - 落库同样容错（失败吞掉），payload 仅含数量与物品名，不含任何敏感信息；
 * - stop 必须干净不挂起（吸取 Task6 教训）：仅 clearInterval + 置空句柄，不 await 任何 Promise。
 */

import { listExpiringItems } from '../db/repository.js';
import type { AppDatabase } from '../db/client.js';
import { eventLogs } from '../db/schema.js';
import { exposeExpiringToHa } from '../ha/ha-expose.js';
import { isHaConfigured, type HaConfig } from '../ha/config.js';
import type { HaClient } from '../ha/ha-client.js';
import { loadReminderConfig, type ReminderConfig } from './config.js';

/** 单次检查结果。 */
export interface ReminderCheckResult {
  /** 临期物品数量 */
  count: number;
  /** 临期物品名列表（按到期日升序） */
  itemNames: string[];
  /** 本次是否已把临期统计暴露到 HA（已配置且暴露调用成功时为 true） */
  exposed: boolean;
}

/** createReminderScheduler 依赖注入入参。 */
export interface CreateReminderSchedulerDeps {
  /** 数据库实例 */
  db: AppDatabase;
  /** HA REST 客户端（缺省不暴露到 HA） */
  haClient?: HaClient;
  /** HA 配置（缺省/未配置时不暴露到 HA） */
  haConfig?: HaConfig;
  /** 提醒配置，缺省调用 loadReminderConfig() */
  config?: ReminderConfig;
  /** 基准时间获取函数（毫秒），默认 Date.now（便于测试注入固定值） */
  now?: () => number;
}

/** 提醒调度器对外接口。 */
export interface ReminderScheduler {
  /** 启动定时检查（已启动则幂等返回） */
  start(): void;
  /** 停止定时检查：同步 clearInterval + 置空句柄，不 await（干净不挂起） */
  stop(): void;
  /** 手动触发一次检查（供定时器与手动触发路由复用） */
  checkOnce(): Promise<ReminderCheckResult>;
}

/**
 * 创建主动到期提醒调度器。
 * @param deps 依赖注入：db 必填，haClient/haConfig/config/now 可选。
 */
export function createReminderScheduler(deps: CreateReminderSchedulerDeps): ReminderScheduler {
  const { db, haClient, haConfig } = deps;
  const config = deps.config ?? loadReminderConfig();
  const now = deps.now ?? Date.now;

  let timer: ReturnType<typeof setInterval> | null = null;

  async function checkOnce(): Promise<ReminderCheckResult> {
    const current = now();
    // 复用仓储层查询：N 天内到期（含已过期），按到期日升序
    const items = listExpiringItems(db, config.expiryDays, current);
    const itemNames = items.map((i) => i.name);
    const count = items.length;

    // 无临期物品：不暴露、不落 reminder 日志，直接返回
    if (count === 0) {
      return { count: 0, itemNames: [], exposed: false };
    }

    // HA 已配置则尝试暴露到传感器；失败不抛、不影响后续落库
    let exposed = false;
    if (haClient && haConfig && isHaConfigured(haConfig)) {
      try {
        await exposeExpiringToHa(haClient, db, config.expiryDays, current);
        exposed = true;
      } catch {
        // HA 暴露失败（如暂时不可达）静默忽略，不写令牌/不回显；本次 exposed 保持 false
      }
    }

    // 无论 HA 是否配置/成功，只要有临期物品就落一条 eventLog(source='reminder')；
    // 容错写库、失败吞掉，payload 仅含数量与物品名（不含任何敏感信息）
    try {
      db.insert(eventLogs)
        .values({
          eventType: 'reminder',
          payload: JSON.stringify({ count, itemNames }),
          source: 'reminder',
        })
        .run();
    } catch {
      // 事件日志落库失败不影响主流程
    }

    return { count, itemNames, exposed };
  }

  function start(): void {
    if (timer !== null) {
      return;
    }
    timer = setInterval(() => {
      // 吞掉异步错误：单次检查失败不应中断进程或抛未处理拒绝
      void checkOnce().catch(() => {
        // 静默忽略；下一次定时将重试
      });
    }, config.intervalMs);
  }

  function stop(): void {
    // 仅 clearInterval + 置空句柄，绝不 await 任何 Promise（干净不挂起）
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, checkOnce };
}
