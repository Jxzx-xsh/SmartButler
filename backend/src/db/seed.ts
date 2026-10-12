/**
 * 种子脚本：插入示例分类与食材。
 *
 * 包含“两盒牛奶，保质期到下周五”这类场景，并涵盖“即将到期”（数天内）
 * 与“还早”（约一个月后）各若干条，便于验证到期查询。
 * 使用 repository.createItem 以复用自动算到期逻辑。
 *
 * 可通过 `npm run db:seed` 直接运行（会先确保表存在）。
 */

import type Database from 'better-sqlite3';

import type { AppDatabase } from './client.js';
import { categories } from './schema.js';
import { createItem } from './repository.js';
import { initSchema } from './init.js';
import { MS_PER_DAY } from '../domain/expiry.js';

/** 计算从给定时刻起、下一个周五的毫秒时间戳（含“今天就是周五”则取 7 天后） */
export function nextFriday(now: number = Date.now()): number {
  const date = new Date(now);
  const day = date.getDay(); // 0=周日 … 5=周五
  // 距离下一个周五的天数（若今天是周五则取下周五，避免“已到期”歧义）
  let delta = (5 - day + 7) % 7;
  if (delta === 0) {
    delta = 7;
  }
  return now + delta * MS_PER_DAY;
}

/**
 * 向数据库写入示例数据，返回插入统计。
 * @param db drizzle 实例
 * @param now 基准时间（便于测试注入固定时钟）
 */
export function seedData(
  db: AppDatabase,
  now: number = Date.now(),
): { categoryCount: number; itemCount: number } {
  // ── 分类 ──
  const categoryRows = db
    .insert(categories)
    .values([
      { name: '乳制品', icon: 'milk', color: '#A7C7E7' },
      { name: '蔬果', icon: 'carrot', color: '#8FBF8F' },
      { name: '日用品', icon: 'box', color: '#D9B38C' },
    ])
    .returning()
    .all();

  const byName = new Map(categoryRows.map((c) => [c.name, c.id]));
  const dairyId = byName.get('乳制品');
  const produceId = byName.get('蔬果');
  const dailyId = byName.get('日用品');

  // ── 食材/物品 ──
  // 两盒牛奶，保质期到下周五（即将到期场景之一）
  createItem(db, {
    name: '牛奶',
    quantity: 2,
    unit: '盒',
    categoryId: dairyId ?? null,
    location: '冰箱',
    expiryDate: nextFriday(now),
    source: 'manual',
    note: '两盒牛奶，保质期到下周五',
  });

  // 酸奶：2 天后到期（即将到期）
  createItem(db, {
    name: '酸奶',
    quantity: 4,
    unit: '杯',
    categoryId: dairyId ?? null,
    location: '冰箱',
    purchaseDate: now,
    shelfLifeDays: 2,
    source: 'manual',
  });

  // 菠菜：1 天后到期（即将到期）
  createItem(db, {
    name: '菠菜',
    quantity: 1,
    unit: '把',
    categoryId: produceId ?? null,
    location: '冰箱',
    purchaseDate: now,
    shelfLifeDays: 1,
    source: 'manual',
  });

  // 苹果：30 天后到期（还早）
  createItem(db, {
    name: '苹果',
    quantity: 6,
    unit: '个',
    categoryId: produceId ?? null,
    location: '果篮',
    purchaseDate: now,
    shelfLifeDays: 30,
    source: 'manual',
  });

  // 洗衣液：无到期日（日用品，不参与到期筛选）
  createItem(db, {
    name: '洗衣液',
    quantity: 1,
    unit: '瓶',
    categoryId: dailyId ?? null,
    location: '储物柜',
    source: 'manual',
  });

  return { categoryCount: categoryRows.length, itemCount: 5 };
}

/** 直接运行时的入口：对默认连接建表并写入示例数据 */
async function main(): Promise<void> {
  const { db, sqlite } = (await import('./client.js')) as {
    db: AppDatabase;
    sqlite: Database.Database;
  };
  initSchema(sqlite);
  const { categoryCount, itemCount } = seedData(db);
  console.log(
    `[db:seed] 已插入 ${categoryCount} 个分类、${itemCount} 条食材。`,
  );
}

// 仅在作为脚本直接执行时运行 main
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[db:seed] 失败：', err);
    process.exit(1);
  });
}
