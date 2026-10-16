/** 临期暴露单元测试（内存库 + mock HA 客户端） */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';
import { MS_PER_DAY } from '../domain/expiry.js';
import type { HaClient } from './ha-client.js';
import { EXPIRING_SENSOR_ENTITY, exposeExpiringToHa } from './ha-expose.js';

// 固定基准时间
const NOW = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
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

describe('exposeExpiringToHa', () => {
  it('调用 setState 恰一次，state 与 item_names 与临期项一致（升序）', async () => {
    // 已过期 1 天
    createItem(db, { name: '已过期菜', expiryDate: NOW - 1 * MS_PER_DAY });
    // 2 天后到期
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    // 10 天后到期（范围外）
    createItem(db, { name: '苹果', expiryDate: NOW + 10 * MS_PER_DAY });

    const client = makeMockClient();
    const result = await exposeExpiringToHa(client, db, 3, NOW);

    expect(client.setState).toHaveBeenCalledTimes(1);
    const [entityId, body] = (client.setState as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { state: string; attributes: Record<string, unknown> }];

    expect(entityId).toBe(EXPIRING_SENSOR_ENTITY);
    expect(body.state).toBe('2');
    expect(body.attributes.item_names).toEqual(['已过期菜', '酸奶']);
    expect(body.attributes.days).toBe(3);

    expect(result).toEqual({
      entityId: EXPIRING_SENSOR_ENTITY,
      count: 2,
      itemNames: ['已过期菜', '酸奶'],
    });
  });

  it('days 默认 3 生效', async () => {
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    createItem(db, { name: '牛奶', expiryDate: NOW + 5 * MS_PER_DAY });

    const client = makeMockClient();
    // 不传 days，走默认 3
    const result = await exposeExpiringToHa(client, db, undefined, NOW);
    expect(result.count).toBe(1);
    expect(result.itemNames).toEqual(['酸奶']);
  });

  it('无临期项 → state 0、item_names 空数组', async () => {
    createItem(db, { name: '苹果', expiryDate: NOW + 10 * MS_PER_DAY });

    const client = makeMockClient();
    const result = await exposeExpiringToHa(client, db, 3, NOW);

    const [, body] = (client.setState as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { state: string; attributes: Record<string, unknown> },
    ];
    expect(body.state).toBe('0');
    expect(body.attributes.item_names).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.itemNames).toEqual([]);
  });
});
