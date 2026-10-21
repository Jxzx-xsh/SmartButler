/** 物品消耗 / 用完登记路由集成测试（Fastify inject + 独立内存库） */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { consumeItem, createItem } from '../db/repository.js';
import { buildApp } from '../app.js';

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(async () => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
  app = buildApp({ db });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/items/:id/consume', () => {
  it('默认减 1，返回 200 且 item.quantity 减一、depleted=false', async () => {
    const item = createItem(db, { name: '酸奶', quantity: 3 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/consume`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.consumed).toBe(true);
    expect(body.depleted).toBe(false);
    expect(body.item.quantity).toBe(2);
  });

  it('消耗到 0 返回 depleted=true、item 非 null 且 quantity=0，物品保留可查到', async () => {
    const item = createItem(db, { name: '牛奶', quantity: 1 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/consume`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.depleted).toBe(true);
    expect(body.item).not.toBeNull();
    expect(body.item.quantity).toBe(0);
    expect(body.message).toBe('已用完，已移至已用完分组');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/items/${item.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().quantity).toBe(0);
  });

  it("支持 eventType='discarded'", async () => {
    const item = createItem(db, { name: '剩菜', quantity: 2 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/consume`,
      payload: { eventType: 'discarded', quantity: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().item.quantity).toBe(1);

    const history = await app.inject({
      method: 'GET',
      url: '/api/consumption/history',
    });
    expect(history.json()[0].eventType).toBe('discarded');
  });

  it('不存在的 id 返回 404 ITEM_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items/9999/consume',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ITEM_NOT_FOUND');
  });

  it('quantity 非正整数返回 400 VALIDATION_ERROR', async () => {
    const item = createItem(db, { name: '牛奶', quantity: 3 });
    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/consume`,
      payload: { quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/consumption/history', () => {
  it('按 recordedAt 降序返回，并带物品名', async () => {
    const a = createItem(db, { name: '牛奶', quantity: 5 });
    const b = createItem(db, { name: '酸奶', quantity: 5 });
    // 用仓储显式注入 recordedAt，保证排序可断言
    consumeItem(db, a.id, { recordedAt: 1000 });
    consumeItem(db, b.id, { recordedAt: 2000 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/consumption/history',
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.map((r: { recordedAt: number }) => r.recordedAt)).toEqual([
      2000, 1000,
    ]);
    expect(rows[0].itemName).toBe('酸奶');
  });
});
