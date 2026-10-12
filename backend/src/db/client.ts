/**
 * 数据库连接与 drizzle 实例。
 *
 * - SQLite 文件路径从环境变量 SMARTBUTLER_DB_PATH 读取；
 *   未设置时默认 backend/data/smartbutler.db（自动创建 data 目录）。
 * - 开启 WAL 模式以提升并发读写表现。
 * - 导出默认实例 db / 底层连接 sqlite，以及工厂函数 createDb（供测试传入 :memory:）。
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { schema } from './schema.js';

/** 当前文件所在目录（ESM 下手动推导 __dirname） */
const currentDir = dirname(fileURLToPath(import.meta.url));

/** backend/ 根目录（src/db → 上两级） */
const backendRoot = resolve(currentDir, '..', '..');

/** 默认数据库文件路径 */
export const DEFAULT_DB_PATH = resolve(backendRoot, 'data', 'smartbutler.db');

/** drizzle 实例类型别名（供仓储层函数签名复用） */
export type AppDatabase = ReturnType<typeof createDb>['db'];

/**
 * 创建数据库连接与 drizzle 实例。
 * @param dbPath SQLite 文件路径或 ':memory:'；缺省时读取环境变量或使用默认路径。
 */
export function createDb(dbPath?: string): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: Database.Database;
} {
  const target = dbPath ?? process.env.SMARTBUTLER_DB_PATH ?? DEFAULT_DB_PATH;

  // 对真实文件路径确保父目录存在（:memory: 等特殊目标跳过）
  if (target !== ':memory:') {
    mkdirSync(dirname(resolve(target)), { recursive: true });
  }

  const sqlite = new Database(target);
  // 开启 WAL 模式（内存库对该 PRAGMA 无副作用）
  sqlite.pragma('journal_mode = WAL');
  // 开启外键约束
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** 默认连接（读取环境变量或默认路径） */
const defaultConnection = createDb();

/** 默认 drizzle 实例 */
export const db = defaultConnection.db;

/** 默认底层 better-sqlite3 连接 */
export const sqlite = defaultConnection.sqlite;
