/** 物品路由集成测试（Fastify inject + 独立内存库） */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';
import { categories } from '../db/schema.js';
import { buildApp } from '../app.js';
import { MS_PER_DAY } from '../domain/expiry.js';

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

describe('POST /api/items', () => {
  it('用 purchaseDate + shelfLifeDays 创建并自动算到期日，返回 201', async () => {
    const purchaseDate = Date.UTC(2024, 0, 1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '酸奶', purchaseDate, shelfLifeDays: 5 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('酸奶');
    expect(body.expiryDate).toBe(purchaseDate + 5 * MS_PER_DAY);
    expect(body).toHaveProperty('daysUntilExpiry');
  });

  it('直接给 expiryDate 时不被覆盖', async () => {
    const expiryDate = Date.UTC(2024, 5, 1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '牛奶', expiryDate },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expiryDate).toBe(expiryDate);
  });

  it('日期以 ISO 字符串传入时归一化为毫秒整数', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '牛奶', expiryDate: '2024-06-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().expiryDate).toBe(Date.UTC(2024, 5, 1, 0, 0, 0, 0));
  });

  it('缺少 name 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { quantity: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('name 为空返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('quantity 非正返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '牛奶', quantity: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('可选字段显式传 null 时后端容错，返回 201 且 note 为 null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '牛奶', note: null, unit: null },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.note).toBeNull();
    expect(body.unit).toBeNull();
  });

  it('省略可选字段仍能创建，返回 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: { name: '牛奶' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('牛奶');
  });
});

describe('GET /api/items 列表与过滤', () => {
  beforeEach(() => {
    // 先建分类，满足外键约束
    db.insert(categories)
      .values([{ name: '乳制品' }, { name: '蔬果' }])
      .run();
    createItem(db, { name: '牛奶', categoryId: 1, location: '冰箱' });
    createItem(db, { name: '苹果', categoryId: 2, location: '果篮' });
    createItem(db, {
      name: '酸奶',
      categoryId: 1,
      location: '冰箱',
      confirmed: false,
    });
  });

  it('无过滤返回全部，且每项含 daysUntilExpiry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(3);
    expect(body[0]).toHaveProperty('daysUntilExpiry');
  });

  it('按 categoryId 过滤', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items?categoryId=1',
    });
    const names = res.json().map((r: { name: string }) => r.name).sort();
    expect(names).toEqual(['牛奶', '酸奶']);
  });

  it('按 location 过滤', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items?location=果篮',
    });
    expect(res.json().map((r: { name: string }) => r.name)).toEqual(['苹果']);
  });

  it('按 confirmed 过滤', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items?confirmed=false',
    });
    expect(res.json().map((r: { name: string }) => r.name)).toEqual(['酸奶']);
  });
});

describe('GET /api/items/expiring', () => {
  beforeEach(() => {
    const now = Date.now();
    createItem(db, { name: '已过期菜', expiryDate: now - 1 * MS_PER_DAY });
    createItem(db, { name: '酸奶', expiryDate: now + 2 * MS_PER_DAY });
    createItem(db, { name: '牛奶', expiryDate: now + 10 * MS_PER_DAY });
    createItem(db, { name: '洗衣液' });
  });

  it('默认 days=3，返回三天内到期（含已过期），按到期日升序', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/expiring',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { name: string }) => r.name)).toEqual([
      '已过期菜',
      '酸奶',
    ]);
  });

  it('days 参数生效', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/expiring?days=30',
    });
    expect(res.json().map((r: { name: string }) => r.name)).toEqual([
      '已过期菜',
      '酸奶',
      '牛奶',
    ]);
  });

  it('days=0 返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/expiring?days=0',
    });
    expect(res.statusCode).toBe(400);
  });

  it('days 为负返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/expiring?days=-1',
    });
    expect(res.statusCode).toBe(400);
  });

  it('days 非整数返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/items/expiring?days=1.5',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/items/:id', () => {
  it('存在返回 200', async () => {
    const item = createItem(db, { name: '牛奶' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/items/${item.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('牛奶');
  });

  it('不存在返回 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/items/9999' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ITEM_NOT_FOUND');
  });
});

describe('PATCH /api/items/:id', () => {
  it('更新字段', async () => {
    const item = createItem(db, { name: '牛奶', quantity: 1 });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { quantity: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quantity).toBe(3);
  });

  it('改 purchaseDate/shelfLifeDays 时重算到期日', async () => {
    const item = createItem(db, { name: '酸奶' });
    const purchaseDate = Date.UTC(2024, 0, 1);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { purchaseDate, shelfLifeDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiryDate).toBe(purchaseDate + 7 * MS_PER_DAY);
  });

  it('显式给 expiryDate 时不重算', async () => {
    const item = createItem(db, { name: '酸奶' });
    const explicit = Date.UTC(2024, 5, 1);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { purchaseDate: Date.UTC(2024, 0, 1), shelfLifeDays: 7, expiryDate: explicit },
    });
    expect(res.json().expiryDate).toBe(explicit);
  });

  it('显式传 note:null 清空备注，返回 200 且 note 为 null', async () => {
    const item = createItem(db, { name: '牛奶', note: '尽快喝完' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { note: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().note).toBeNull();
  });

  it('显式传 unit/location/categoryId 为 null 时三者均清空', async () => {
    db.insert(categories).values({ name: '乳制品' }).run();
    const item = createItem(db, {
      name: '牛奶',
      unit: '盒',
      location: '冰箱',
      categoryId: 1,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { unit: null, location: null, categoryId: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unit).toBeNull();
    expect(body.location).toBeNull();
    expect(body.categoryId).toBeNull();
  });

  it('清空 purchaseDate/shelfLifeDays（均传 null）时到期日被重算为 null', async () => {
    const item = createItem(db, {
      name: '酸奶',
      purchaseDate: Date.UTC(2024, 0, 1),
      shelfLifeDays: 5,
    });
    // 原本有到期日
    expect(item.expiryDate).not.toBeNull();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { purchaseDate: null, shelfLifeDays: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.purchaseDate).toBeNull();
    expect(body.shelfLifeDays).toBeNull();
    // computeExpiryDate(null, null) = null，清空组合应重算为 null 而非旧值
    expect(body.expiryDate).toBeNull();
  });

  it('显式传 expiryDate:null 清空到期日且不触发重算', async () => {
    const item = createItem(db, {
      name: '酸奶',
      purchaseDate: Date.UTC(2024, 0, 1),
      shelfLifeDays: 5,
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { expiryDate: null },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expiryDate).toBeNull();
    // 未动 purchaseDate/shelfLifeDays，二者保持原值（未被重算路径影响）
    expect(body.purchaseDate).toBe(Date.UTC(2024, 0, 1));
    expect(body.shelfLifeDays).toBe(5);
  });

  it('同时传 purchaseDate/shelfLifeDays 与 expiryDate:null 时显式 null 优先、不重算', async () => {
    const item = createItem(db, { name: '酸奶' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: {
        purchaseDate: Date.UTC(2024, 0, 1),
        shelfLifeDays: 7,
        expiryDate: null,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 显式 null 的三态语义优先于重算
    expect(body.expiryDate).toBeNull();
    expect(body.purchaseDate).toBe(Date.UTC(2024, 0, 1));
    expect(body.shelfLifeDays).toBe(7);
  });

  it('省略 expiryDate 键只传 purchaseDate/shelfLifeDays 时仍重算到期日（回归保护 Task 3）', async () => {
    const item = createItem(db, { name: '酸奶' });
    const purchaseDate = Date.UTC(2024, 0, 1);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { purchaseDate, shelfLifeDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiryDate).toBe(purchaseDate + 7 * MS_PER_DAY);
  });

  it('不存在返回 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/items/9999',
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/items/:id', () => {
  it('存在返回 204', async () => {
    const item = createItem(db, { name: '牛奶' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/items/${item.id}`,
    });
    expect(res.statusCode).toBe(204);
  });

  it('不存在返回 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/items/9999' });
    expect(res.statusCode).toBe(404);
  });
});
