/** 提醒调度器单元测试（vi.useFakeTimers + 内存库 + mock haClient + 固定 now） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';
import { eventLogs } from '../db/schema.js';
import { MS_PER_DAY } from '../domain/expiry.js';
import type { HaConfig } from '../ha/config.js';
import type { HaClient } from '../ha/ha-client.js';
import { createReminderScheduler } from './reminder-scheduler.js';
import type { ReminderConfig } from './config.js';

// 固定基准时间
const NOW = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

/** 测试用提醒配置：短间隔便于推进假定时器 */
const TEST_CONFIG: ReminderConfig = { intervalMs: 1000, expiryDays: 3 };

/** 已配置的 HA 配置 */
const CONFIGURED_HA: HaConfig = {
  baseUrl: 'http://ha:8123',
  token: 'secret',
  wsUrl: 'ws://ha:8123/api/websocket',
  timeoutMs: 10000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  stateChangedEventType: 'state_changed',
};

/** 未配置的 HA 配置（baseUrl/token 为空） */
const UNCONFIGURED_HA: HaConfig = {
  baseUrl: '',
  token: '',
  wsUrl: '',
  timeoutMs: 10000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  stateChangedEventType: 'state_changed',
};

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(() => {
  vi.useRealTimers();
});

/** 构造仅实现 setState 的 mock HA 客户端 */
function makeMockClient(): HaClient {
  return {
    ping: vi.fn(),
    getStates: vi.fn(),
    getState: vi.fn(),
    callService: vi.fn(),
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    setState: vi.fn().mockResolvedValue({}),
  } as unknown as HaClient;
}

/** 统计 eventLogs 中 source='reminder' 的行数。 */
function reminderLogCount(): number {
  return db
    .select()
    .from(eventLogs)
    .all()
    .filter((r) => r.source === 'reminder').length;
}

describe('createReminderScheduler.checkOnce', () => {
  it('有临期物品 → 落一条 eventLog(source=reminder)', async () => {
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });

    const scheduler = createReminderScheduler({
      db,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    const result = await scheduler.checkOnce();

    expect(result.count).toBe(1);
    expect(result.itemNames).toEqual(['酸奶']);
    expect(reminderLogCount()).toBe(1);
  });

  it('HA 已配置 → 调 exposeExpiring 且 exposed=true', async () => {
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    const client = makeMockClient();

    const scheduler = createReminderScheduler({
      db,
      haClient: client,
      haConfig: CONFIGURED_HA,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    const result = await scheduler.checkOnce();

    expect(client.setState).toHaveBeenCalledTimes(1);
    expect(result.exposed).toBe(true);
    expect(reminderLogCount()).toBe(1);
  });

  it('HA 未配置 → 不调 exposeExpiring 但仍落 eventLog(exposed=false)', async () => {
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    const client = makeMockClient();

    const scheduler = createReminderScheduler({
      db,
      haClient: client,
      haConfig: UNCONFIGURED_HA,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    const result = await scheduler.checkOnce();

    expect(client.setState).not.toHaveBeenCalled();
    expect(result.exposed).toBe(false);
    expect(reminderLogCount()).toBe(1);
  });

  it('无临期物品 → 不落 reminder 日志', async () => {
    createItem(db, { name: '苹果', expiryDate: NOW + 10 * MS_PER_DAY });

    const scheduler = createReminderScheduler({
      db,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    const result = await scheduler.checkOnce();

    expect(result.count).toBe(0);
    expect(result.exposed).toBe(false);
    expect(reminderLogCount()).toBe(0);
  });

  it('exposeExpiring 抛错不影响落 eventLog、不向上抛', async () => {
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    const client = makeMockClient();
    (client.setState as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('HA 暂时不可达'),
    );

    const scheduler = createReminderScheduler({
      db,
      haClient: client,
      haConfig: CONFIGURED_HA,
      config: TEST_CONFIG,
      now: () => NOW,
    });

    // 不向上抛
    const result = await scheduler.checkOnce();
    expect(result.exposed).toBe(false);
    // 仍落 eventLog
    expect(reminderLogCount()).toBe(1);
  });
});

describe('createReminderScheduler start/stop', () => {
  it('start 后推进 intervalMs 触发一次 checkOnce', async () => {
    vi.useFakeTimers();
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });

    const scheduler = createReminderScheduler({
      db,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    scheduler.start();

    // 推进一个间隔触发定时回调，并等待其内部异步 checkOnce 落库完成
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.intervalMs);

    expect(reminderLogCount()).toBe(1);
    scheduler.stop();
  });

  it('stop 后推进时间不再触发且 stop 立即返回（不挂起）', async () => {
    vi.useFakeTimers();
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });

    const scheduler = createReminderScheduler({
      db,
      config: TEST_CONFIG,
      now: () => NOW,
    });
    scheduler.start();

    // stop 为同步函数：调用即返回，不 await 任何 Promise
    const ret = scheduler.stop();
    expect(ret).toBeUndefined();

    // 停止后推进时间不应再触发检查
    await vi.advanceTimersByTimeAsync(TEST_CONFIG.intervalMs * 3);
    expect(reminderLogCount()).toBe(0);
  });
});
