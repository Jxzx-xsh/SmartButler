/** 数据访问层集成测试（内存 SQLite） */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type AppDatabase } from './client.js';
import { initSchema } from './init.js';
import { categories } from './schema.js';
import {
  createItem,
  deleteItem,
  getItem,
  listExpiringItems,
  listItems,
  updateItem,
} from './repository.js';
import { MS_PER_DAY } from '../domain/expiry.js';

// 固定基准时间
const NOW = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

let db: AppDatabase;

beforeEach(() => {
  // 每个用例使用独立的内存库
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

describe('createItem 自动计算到期日', () => {
  it('仅给 purchaseDate + shelfLifeDays 时自动算出 expiryDate', () => {
    const item = createItem(db, {
      name: '酸奶',
      purchaseDate: NOW,
      shelfLifeDays: 5,
    });
    expect(item.expiryDate).toBe(NOW + 5 * MS_PER_DAY);
  });

  it('显式给 expiryDate 时不被覆盖', () => {
    const explicit = NOW + 100 * MS_PER_DAY;
    const item = createItem(db, {
      name: '牛奶',
      purchaseDate: NOW,
      shelfLifeDays: 5,
      expiryDate: explicit,
    });
    expect(item.expiryDate).toBe(explicit);
  });

  it('缺少 purchaseDate/shelfLifeDays 时 expiryDate 为 null', () => {
    const item = createItem(db, { name: '洗衣液' });
    expect(item.expiryDate).toBeNull();
  });
});

describe('listItems 过滤', () => {
  beforeEach(() => {
    db.insert(categories)
      .values([{ name: '乳制品' }, { name: '蔬果' }])
      .run();
    createItem(db, { name: '牛奶', categoryId: 1, location: '冰箱' });
    createItem(db, { name: '苹果', categoryId: 2, location: '果篮' });
    createItem(db, { name: '酸奶', categoryId: 1, location: '冰箱' });
  });

  it('按 categoryId 过滤', () => {
    const rows = listItems(db, { categoryId: 1 });
    expect(rows.map((r) => r.name).sort()).toEqual(['牛奶', '酸奶']);
  });

  it('按 location 过滤', () => {
    const rows = listItems(db, { location: '果篮' });
    expect(rows.map((r) => r.name)).toEqual(['苹果']);
  });

  it('组合过滤', () => {
    const rows = listItems(db, { categoryId: 1, location: '冰箱' });
    expect(rows.map((r) => r.name).sort()).toEqual(['牛奶', '酸奶']);
  });

  it('无过滤返回全部', () => {
    expect(listItems(db)).toHaveLength(3);
  });
});

describe('updateItem / deleteItem / getItem', () => {
  it('更新字段并刷新 updatedAt', () => {
    const item = createItem(db, { name: '牛奶', quantity: 1 });
    const updated = updateItem(db, item.id, { quantity: 3 });
    expect(updated?.quantity).toBe(3);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(item.updatedAt);
  });

  it('getItem 返回已存在记录，不存在返回 null', () => {
    const item = createItem(db, { name: '牛奶' });
    expect(getItem(db, item.id)?.name).toBe('牛奶');
    expect(getItem(db, 9999)).toBeNull();
  });

  it('deleteItem 删除后不可再查到', () => {
    const item = createItem(db, { name: '牛奶' });
    expect(deleteItem(db, item.id)).toBe(true);
    expect(getItem(db, item.id)).toBeNull();
    expect(deleteItem(db, item.id)).toBe(false);
  });
});

describe('listExpiringItems', () => {
  beforeEach(() => {
    // 已过期 1 天
    createItem(db, {
      name: '已过期菜',
      expiryDate: NOW - 1 * MS_PER_DAY,
    });
    // 2 天后到期
    createItem(db, { name: '酸奶', expiryDate: NOW + 2 * MS_PER_DAY });
    // 恰好 3 天后到期（边界）
    createItem(db, { name: '牛奶', expiryDate: NOW + 3 * MS_PER_DAY });
    // 10 天后到期（范围外）
    createItem(db, { name: '苹果', expiryDate: NOW + 10 * MS_PER_DAY });
    // 无到期日
    createItem(db, { name: '洗衣液' });
  });

  it('只返回 N 天内（含已过期）的物品，按到期日升序', () => {
    const rows = listExpiringItems(db, 3, NOW);
    expect(rows.map((r) => r.name)).toEqual(['已过期菜', '酸奶', '牛奶']);
  });

  it('无到期日的物品不出现', () => {
    const rows = listExpiringItems(db, 3, NOW);
    expect(rows.some((r) => r.name === '洗衣液')).toBe(false);
  });

  it('范围外物品不出现', () => {
    const rows = listExpiringItems(db, 3, NOW);
    expect(rows.some((r) => r.name === '苹果')).toBe(false);
  });
});
