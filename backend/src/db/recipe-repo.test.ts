/** 收藏食谱仓储集成测试（内存 SQLite） */

import { beforeEach, describe, expect, it } from 'vitest';

import { createDb, type AppDatabase } from './client.js';
import { initSchema } from './init.js';
import {
  listSavedRecipes,
  removeSavedRecipe,
  saveRecipe,
} from './recipe-repo.js';

let db: AppDatabase;

beforeEach(() => {
  // 每个用例使用独立的内存库
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

describe('saveRecipe', () => {
  it('返回含 id/createdAt，且 usedItems 为真正数组', () => {
    const saved = saveRecipe(db, {
      name: '番茄炒蛋',
      usedItems: ['番茄', '鸡蛋'],
    });
    expect(saved.id).toBeTypeOf('number');
    expect(saved.createdAt).toBeTypeOf('number');
    expect(saved.usedItems).toEqual(['番茄', '鸡蛋']);
  });

  it('只传 name 时 usedItems=[]、missingItems/steps 为 null', () => {
    const saved = saveRecipe(db, { name: '白米饭' });
    expect(saved.usedItems).toEqual([]);
    expect(saved.missingItems).toBeNull();
    expect(saved.steps).toBeNull();
    expect(saved.note).toBeNull();
  });

  it('missingItems/steps 存取往返为原数组', () => {
    const saved = saveRecipe(db, {
      name: '红烧肉',
      usedItems: ['五花肉'],
      missingItems: ['冰糖', '生抽'],
      steps: ['焯水', '炒糖色', '焖煮'],
      note: '少放盐',
    });
    const [row] = listSavedRecipes(db);
    expect(row?.missingItems).toEqual(['冰糖', '生抽']);
    expect(row?.steps).toEqual(['焯水', '炒糖色', '焖煮']);
    expect(row?.note).toBe('少放盐');
    // 新查出的视图与返回视图一致
    expect(row?.id).toBe(saved.id);
  });

  it('允许重复：同 name 存两次得两条不同 id', () => {
    const a = saveRecipe(db, { name: '番茄炒蛋' });
    const b = saveRecipe(db, { name: '番茄炒蛋' });
    expect(a.id).not.toBe(b.id);
    expect(listSavedRecipes(db)).toHaveLength(2);
  });
});

describe('listSavedRecipes 排序', () => {
  it('按 createdAt 倒序返回（后收藏的在前）', () => {
    const first = saveRecipe(db, { name: '早菜' });
    const second = saveRecipe(db, { name: '晚菜' });
    const rows = listSavedRecipes(db);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
  });
});

describe('removeSavedRecipe', () => {
  it('存在则返回 true 且列表减一', () => {
    const saved = saveRecipe(db, { name: '番茄炒蛋' });
    expect(listSavedRecipes(db)).toHaveLength(1);
    expect(removeSavedRecipe(db, saved.id)).toBe(true);
    expect(listSavedRecipes(db)).toHaveLength(0);
  });

  it('不存在则返回 false', () => {
    expect(removeSavedRecipe(db, 9999)).toBe(false);
  });
});
