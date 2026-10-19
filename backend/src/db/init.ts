/**
 * 建表脚本：使用原生 SQL CREATE TABLE IF NOT EXISTS 建立全部表。
 *
 * 字段/类型/约束/外键与 schema.ts 严格对应：
 * - 日期统一为 INTEGER（毫秒时间戳）；
 * - 布尔 confirmed 存为 INTEGER（0/1）；
 * - 枚举 source / event_type 存为 TEXT。
 * 建表顺序满足外键依赖：category、item 在前。
 *
 * 可通过 `npm run db:init` 直接运行，对默认连接执行建表并打印结果。
 */

import type Database from 'better-sqlite3';

/**
 * 在给定的 better-sqlite3 连接上创建全部表（幂等）。
 * @param sqlite better-sqlite3 连接实例
 */
export function initSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS category (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE,
      icon  TEXT,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS item (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      quantity        INTEGER NOT NULL DEFAULT 1,
      unit            TEXT,
      category_id     INTEGER REFERENCES category(id),
      location        TEXT,
      purchase_date   INTEGER,
      shelf_life_days INTEGER,
      expiry_date     INTEGER,
      confirmed       INTEGER NOT NULL DEFAULT 1,
      source          TEXT NOT NULL DEFAULT 'manual',
      note            TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expiry_record (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER REFERENCES item(id) ON DELETE SET NULL,
      event_type  TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload    TEXT,
      source     TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

/** 直接运行时的入口：对默认连接建表并打印结果 */
async function main(): Promise<void> {
  const { sqlite } = await import('./client.js');
  initSchema(sqlite);

  // 查询 sqlite_master 确认表已创建
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;

  console.log('[db:init] 建表完成，当前表：', tables.map((t) => t.name).join(', '));
}

// 仅在作为脚本直接执行时运行 main（被 import 时不触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[db:init] 失败：', err);
    process.exit(1);
  });
}
