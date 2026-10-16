/** persistParsedItems 单元测试（内存 SQLite + initSchema） */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type AppDatabase } from './client.js';
import { initSchema } from './init.js';
import { persistParsedItems } from './persist-items.js';
import { createCategory, listItems } from './repository.js';
import type { ParsedItem } from '../ai/item-parser.js';

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

describe('persistParsedItems', () => {
  it('source 参数正确写入（manual）', () => {
    const items: ParsedItem[] = [{ name: '牛奶' }];
    const created = persistParsedItems(db, items, 'manual');

    expect(created).toHaveLength(1);
    expect(created[0]?.source).toBe('manual');
    expect(created[0]?.confirmed).toBe(true);
    // 落库校验
    expect(listItems(db)[0]?.source).toBe('manual');
  });

  it('source 参数正确写入（voice）', () => {
    const items: ParsedItem[] = [{ name: '牛奶' }];
    const created = persistParsedItems(db, items, 'voice');

    expect(created[0]?.source).toBe('voice');
    expect(listItems(db)[0]?.source).toBe('voice');
  });

  it('分类名命中时 categoryId 正确', () => {
    const cat = createCategory(db, { name: '乳制品' });
    const items: ParsedItem[] = [{ name: '牛奶', category: '乳制品' }];
    const created = persistParsedItems(db, items, 'voice');

    expect(created[0]?.categoryId).toBe(cat.id);
  });

  it('分类名未命中时 categoryId 为 null', () => {
    const items: ParsedItem[] = [{ name: '牛奶', category: '不存在的分类' }];
    const created = persistParsedItems(db, items, 'voice');

    expect(created[0]?.categoryId).toBeNull();
  });

  it('多物品全部入库且顺序一致', () => {
    const items: ParsedItem[] = [
      { name: '鸡蛋', quantity: 10 },
      { name: '面包', quantity: 1 },
      { name: '牛奶', quantity: 2, unit: '盒' },
    ];
    const created = persistParsedItems(db, items, 'voice');

    expect(created).toHaveLength(3);
    expect(created.map((i) => i.name)).toEqual(['鸡蛋', '面包', '牛奶']);
    expect(listItems(db).map((i) => i.name)).toEqual(['鸡蛋', '面包', '牛奶']);
  });

  it('空数组返回空且不抛', () => {
    const created = persistParsedItems(db, [], 'voice');

    expect(created).toEqual([]);
    expect(listItems(db)).toEqual([]);
  });
});
