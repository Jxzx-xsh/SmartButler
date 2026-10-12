/**
 * SmartButler 核心数据模型（drizzle-orm / SQLite）
 *
 * ─── 日期存储方式决策（全库统一）───────────────────────────────
 * 本项目所有时间字段统一使用 **Unix 毫秒时间戳整数（INTEGER）** 存储。
 * 理由：
 *   1. SQLite 原生没有日期类型，整数毫秒可直接用数值运算比较/排序，
 *      listExpiringItems 的区间查询与升序排序最简单且无时区歧义；
 *   2. 到期计算（purchaseDate + shelfLifeDays * 86400000）为纯整数算术，
 *      避免字符串解析带来的时区/格式问题。
 * 因此 purchaseDate / expiryDate / recordedAt / createdAt / updatedAt
 * 全部为 integer（毫秒）。
 * ──────────────────────────────────────────────────────────
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** 分类表：食材/物品的归类（如 乳制品、蔬果、日用品） */
export const categories = sqliteTable('category', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 分类名称，唯一且非空 */
  name: text('name').notNull().unique(),
  /** 可选图标标识 */
  icon: text('icon'),
  /** 可选颜色（如十六进制色值） */
  color: text('color'),
});

/** 物品/食材表：系统的核心实体 */
export const items = sqliteTable('item', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 名称，非空 */
  name: text('name').notNull(),
  /** 数量，默认 1 */
  quantity: integer('quantity').notNull().default(1),
  /** 单位（盒/袋/个…），可空 */
  unit: text('unit'),
  /** 分类外键 → category.id，可空 */
  categoryId: integer('category_id').references(() => categories.id),
  /** 存放位置（冰箱/储物柜…），可空 */
  location: text('location'),
  /** 购买日期（毫秒时间戳），可空 */
  purchaseDate: integer('purchase_date'),
  /** 保质期天数，可空 */
  shelfLifeDays: integer('shelf_life_days'),
  /** 到期日期（毫秒时间戳），可空 */
  expiryDate: integer('expiry_date'),
  /** 是否已确认入库，默认 true；视频识别入库项应设为 false */
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(true),
  /** 来源：手动/语音/视觉识别，默认 manual */
  source: text('source', { enum: ['manual', 'voice', 'vision'] })
    .notNull()
    .default('manual'),
  /** 备注，可空 */
  note: text('note'),
  /** 创建时间（毫秒时间戳），默认当前时间 */
  createdAt: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
  /** 更新时间（毫秒时间戳），默认当前时间 */
  updatedAt: integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now()),
});

/** 到期/消耗记录表：记录物品的生命周期事件 */
export const expiryRecords = sqliteTable('expiry_record', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 物品外键 → item.id */
  itemId: integer('item_id')
    .notNull()
    .references(() => items.id),
  /** 事件类型：过期/已消耗/已丢弃 */
  eventType: text('event_type', {
    enum: ['expired', 'consumed', 'discarded'],
  }).notNull(),
  /** 记录时间（毫秒时间戳） */
  recordedAt: integer('recorded_at')
    .notNull()
    .$defaultFn(() => Date.now()),
});

/** 事件日志表：通用事件流水（语音/视觉/系统事件等） */
export const eventLogs = sqliteTable('event_log', {
  /** 自增主键 */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 事件类型（自由字符串） */
  eventType: text('event_type').notNull(),
  /** 负载（JSON 字符串文本） */
  payload: text('payload'),
  /** 事件来源 */
  source: text('source'),
  /** 创建时间（毫秒时间戳），默认当前时间 */
  createdAt: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
});

// ─── 推断类型导出（供仓储层与业务层复用）────────────────────────
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;

export type ExpiryRecord = typeof expiryRecords.$inferSelect;
export type NewExpiryRecord = typeof expiryRecords.$inferInsert;

export type EventLog = typeof eventLogs.$inferSelect;
export type NewEventLog = typeof eventLogs.$inferInsert;

/** 聚合 schema 对象，供 drizzle 实例注入 */
export const schema = {
  categories,
  items,
  expiryRecords,
  eventLogs,
};
