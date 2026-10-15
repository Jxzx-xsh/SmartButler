/** 分类名→id 映射单元测试（内存库预置分类，确定性、不触网） */

import { describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { initSchema } from './init.js';
import { createCategory } from './repository.js';
import { categoryKey, buildCategoryIdMap } from './category-map.js';

describe('categoryKey', () => {
  it('去首尾空白并转小写', () => {
    expect(categoryKey('  乳制品  ')).toBe('乳制品');
    expect(categoryKey('Dairy')).toBe('dairy');
    expect(categoryKey('  Fresh FOOD ')).toBe('fresh food');
  });
});

describe('buildCategoryIdMap', () => {
  it('遍历已有分类建去空白+小写 key → id 映射', () => {
    const conn = createDb(':memory:');
    initSchema(conn.sqlite);
    const db = conn.db;

    const dairy = createCategory(db, { name: '乳制品' });
    const snack = createCategory(db, { name: 'Snacks' });

    const map = buildCategoryIdMap(db);
    expect(map.get('乳制品')).toBe(dairy.id);
    // 大小写不敏感：key 为小写
    expect(map.get('snacks')).toBe(snack.id);
    expect(map.get('Snacks')).toBeUndefined();
    // 未命中返回 undefined
    expect(map.get('不存在')).toBeUndefined();
  });

  it('空库返回空映射', () => {
    const conn = createDb(':memory:');
    initSchema(conn.sqlite);
    const map = buildCategoryIdMap(conn.db);
    expect(map.size).toBe(0);
  });
});
