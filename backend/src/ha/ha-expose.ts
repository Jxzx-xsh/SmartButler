/**
 * 临期物品暴露到 Home Assistant。
 *
 * 职责：复用数据访问层的 listExpiringItems 统计 N 天内到期（含已过期）的物品，
 * 通过 HA REST /api/states 写入一个自有传感器实体，把"临期物品数"与物品名列表
 * 暴露给 HA（可用于仪表盘展示或自动化触发）。
 *
 * 已知权衡：通过 REST /api/states 维护的自有传感器实体不会被 HA 持久化，
 * HA 重启后该状态会丢失（HA 不保存由 API 创建的状态）。这是可接受的权衡——
 * 本应用会在运行中定期重新暴露，重启后下一次暴露即可恢复该传感器。
 */

import { listExpiringItems } from '../db/repository.js';
import type { AppDatabase } from '../db/client.js';
import type { HaClient } from './ha-client.js';

/** 暴露临期统计用的自有传感器实体 id。 */
export const EXPIRING_SENSOR_ENTITY = 'sensor.smartbutler_expiring_count';

/** 暴露结果：实体 id、临期数量、临期物品名列表。 */
export interface ExposeResult {
  entityId: string;
  count: number;
  itemNames: string[];
}

/**
 * 把临期物品数与物品名列表暴露为 HA 传感器状态。
 * @param client HA 客户端（经 setState 写入 /api/states）。
 * @param db 数据库实例。
 * @param days 临期窗口天数，默认 3。
 * @param now 基准时间（毫秒），默认当前时间（便于测试注入固定值）。
 */
export async function exposeExpiringToHa(
  client: HaClient,
  db: AppDatabase,
  days = 3,
  now = Date.now(),
): Promise<ExposeResult> {
  // 复用仓储层查询：N 天内到期（含已过期），按到期日升序
  const items = listExpiringItems(db, days, now);
  const itemNames = items.map((i) => i.name);
  const count = items.length;

  await client.setState(EXPIRING_SENSOR_ENTITY, {
    state: String(count),
    attributes: {
      item_names: itemNames,
      days,
      updated_at: new Date(now).toISOString(),
      friendly_name: '临期物品数',
      unit_of_measurement: '件',
    },
  });

  return { entityId: EXPIRING_SENSOR_ENTITY, count, itemNames };
}

/** createExpiringExposer 选项。 */
export interface ExpiringExposerOptions {
  /** 临期窗口天数，默认 3 */
  days?: number;
  /** 暴露间隔毫秒 */
  intervalMs: number;
}

/** 定期暴露器：start 启动定时暴露、stop 清理定时器。 */
export interface ExpiringExposer {
  start(): void;
  stop(): void;
}

/**
 * 创建一个定期把临期统计暴露到 HA 的定时器包装。
 * 回调内 try/catch 吞错，避免单次暴露失败（如 HA 暂时不可达）影响进程；
 * stop 清理定时器，确保不悬挂、进程可正常退出。server 默认不启动它。
 */
export function createExpiringExposer(
  client: HaClient,
  db: AppDatabase,
  opts: ExpiringExposerOptions,
): ExpiringExposer {
  const days = opts.days ?? 3;
  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    if (timer !== null) {
      return;
    }
    timer = setInterval(() => {
      // 吞掉异步错误：定期暴露失败不应中断进程或抛未处理拒绝
      void exposeExpiringToHa(client, db, days).catch(() => {
        // 静默忽略（不写令牌/不回显）；下一次定时将重试
      });
    }, opts.intervalMs);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop };
}
