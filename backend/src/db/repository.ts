/**
 * 数据访问层（物品 / 到期查询）。
 *
 * 所有函数以参数接收 drizzle 实例（AppDatabase），便于测试注入内存库。
 * createItem 在未显式提供 expiryDate 但具备 purchaseDate + shelfLifeDays 时，
 * 自动调用 computeExpiryDate 填充到期日。
 */

import { and, asc, desc, eq, gt, isNotNull, lte, type SQL } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import {
  categories,
  expiryRecords,
  items,
  type Category,
  type ExpiryRecord,
  type Item,
  type NewItem,
} from './schema.js';
import { computeExpiryDate, MS_PER_DAY } from '../domain/expiry.js';

/** createItem 的输入类型：省略由系统生成/派生的字段 */
export type CreateItemInput = Omit<
  NewItem,
  'id' | 'createdAt' | 'updatedAt'
>;

/** listItems 的过滤条件 */
export interface ListItemsFilter {
  categoryId?: number;
  location?: string;
  /** 是否仅返回已确认 / 未确认的物品 */
  confirmed?: boolean;
}

/** updateItem 的补丁类型：允许更新除主键/时间戳外的字段 */
export type UpdateItemPatch = Partial<
  Omit<NewItem, 'id' | 'createdAt' | 'updatedAt'>
>;

/**
 * 新建物品。
 * 若未显式给出 expiryDate 但有 purchaseDate + shelfLifeDays，则自动计算到期日。
 * createdAt/updatedAt 由本函数统一设置为当前时间。
 */
export function createItem(db: AppDatabase, input: CreateItemInput): Item {
  const now = Date.now();

  // 自动计算到期日：仅在调用方未显式提供 expiryDate 时生效
  const expiryDate =
    input.expiryDate ??
    computeExpiryDate(input.purchaseDate ?? null, input.shelfLifeDays ?? null);

  const toInsert: NewItem = {
    ...input,
    expiryDate,
    createdAt: now,
    updatedAt: now,
  };

  const rows = db.insert(items).values(toInsert).returning().all();
  const created = rows[0];
  if (created === undefined) {
    throw new Error('createItem 未返回插入结果');
  }
  return created;
}

/** 按 id 查询单个物品，不存在返回 null */
export function getItem(db: AppDatabase, id: number): Item | null {
  const rows = db.select().from(items).where(eq(items.id, id)).all();
  return rows[0] ?? null;
}

/** 列出物品，支持按 categoryId / location 过滤 */
export function listItems(
  db: AppDatabase,
  filter: ListItemsFilter = {},
): Item[] {
  const conditions: SQL[] = [];
  if (filter.categoryId !== undefined) {
    conditions.push(eq(items.categoryId, filter.categoryId));
  }
  if (filter.location !== undefined) {
    conditions.push(eq(items.location, filter.location));
  }
  if (filter.confirmed !== undefined) {
    conditions.push(eq(items.confirmed, filter.confirmed));
  }

  const base = db.select().from(items);
  if (conditions.length === 0) {
    return base.all();
  }
  return base.where(and(...conditions)).all();
}

/** 更新物品字段，自动刷新 updatedAt，返回更新后的记录（不存在返回 null） */
export function updateItem(
  db: AppDatabase,
  id: number,
  patch: UpdateItemPatch,
): Item | null {
  const rows = db
    .update(items)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(items.id, id))
    .returning()
    .all();
  return rows[0] ?? null;
}

/** 删除物品，返回是否删除成功 */
export function deleteItem(db: AppDatabase, id: number): boolean {
  const rows = db.delete(items).where(eq(items.id, id)).returning().all();
  return rows.length > 0;
}

/**
 * 返回 N 天内到期的物品（含已过期），按到期日升序。
 * 判定：expiryDate 非空且 <= now + days * 一天毫秒，且 quantity > 0。
 * 追加 quantity > 0 条件以排除已用完（quantity<=0）的物品，
 * 这样到期看板 / 主动提醒 / HA 暴露等复用方都不会再提示已用完的物品。
 */
export function listExpiringItems(
  db: AppDatabase,
  days: number,
  now: number = Date.now(),
): Item[] {
  const threshold = now + days * MS_PER_DAY;
  return db
    .select()
    .from(items)
    .where(
      and(
        isNotNull(items.expiryDate),
        lte(items.expiryDate, threshold),
        gt(items.quantity, 0),
      ),
    )
    .orderBy(asc(items.expiryDate))
    .all();
}

// ─── 消耗 / 用完登记 ─────────────────────────────────────────

/** consumeItem 的可选参数 */
export interface ConsumeItemOptions {
  /** 本次消耗数量，默认 1 */
  quantity?: number;
  /** 事件类型：已消耗 / 已丢弃，默认 consumed */
  eventType?: 'consumed' | 'discarded';
  /** 记录时间（毫秒时间戳），默认走 expiryRecords 的 $defaultFn（便于测试显式注入） */
  recordedAt?: number;
}

/**
 * 登记物品消耗 / 用完。
 * 查 item：不存在直接返回 null 且不写任何记录；
 * 存在时按 next = max(0, quantity - qty) 计算剩余：
 *   - next === 0：用完——不删除物品，将 quantity 置 0（刷新 updatedAt），
 *     物品行保留并归入前端「已用完」分组，返回该物品（quantity=0，非 null）；
 *   - next  > 0：扣减数量，返回更新后的记录。
 * 无论归零还是扣减，均向 expiryRecords 插入一条 { itemId, eventType } 留痕。
 * 真正删除物品走 deleteItem（仍触发 expiry_record.item_id 的 ON DELETE SET NULL）。
 */
export function consumeItem(
  db: AppDatabase,
  itemId: number,
  opts: ConsumeItemOptions = {},
): Item | null {
  const item = getItem(db, itemId);
  if (item === null) {
    // 物品不存在：不插记录、返回 null
    return null;
  }

  const qty = opts.quantity ?? 1;
  const eventType = opts.eventType ?? 'consumed';
  const next = Math.max(0, item.quantity - qty);

  // 原子化「插记录 + 更新数量」：先插留痕记录，再把 quantity 置为 next（含归零）。
  // 用完（next===0）也只是把数量置 0 并保留物品行，不再删除。
  return db.transaction((tx) => {
    tx.insert(expiryRecords)
      .values({
        itemId,
        eventType,
        ...(opts.recordedAt !== undefined
          ? { recordedAt: opts.recordedAt }
          : {}),
      })
      .run();

    // 更新数量（next 可能为 0，即用完后归入已用完分组），返回更新后的记录
    const rows = tx
      .update(items)
      .set({ quantity: next, updatedAt: Date.now() })
      .where(eq(items.id, itemId))
      .returning()
      .all();
    return rows[0] ?? null;
  });
}

/** listConsumptionHistory 的可选参数 */
export interface ConsumptionHistoryOptions {
  /** 返回条数上限，默认 50 */
  limit?: number;
  /** 仅查指定物品的消耗记录 */
  itemId?: number;
}

/** 消耗历史记录：expiryRecords 行 + 关联物品名称（物品已删时为 null） */
export type ConsumptionHistoryRow = ExpiryRecord & { itemName: string | null };

/**
 * 列出消耗 / 用完记录，按记录时间降序，leftJoin items 取物品名称
 * （物品已被删除时 itemName 为 null）。默认返回最近 50 条。
 */
export function listConsumptionHistory(
  db: AppDatabase,
  opts: ConsumptionHistoryOptions = {},
): ConsumptionHistoryRow[] {
  const limit = opts.limit ?? 50;

  const base = db
    .select({
      id: expiryRecords.id,
      itemId: expiryRecords.itemId,
      eventType: expiryRecords.eventType,
      recordedAt: expiryRecords.recordedAt,
      itemName: items.name,
    })
    .from(expiryRecords)
    .leftJoin(items, eq(expiryRecords.itemId, items.id));

  const query =
    opts.itemId !== undefined
      ? base.where(eq(expiryRecords.itemId, opts.itemId))
      : base;

  return query.orderBy(desc(expiryRecords.recordedAt)).limit(limit).all();
}

// ─── 分类仓储 ────────────────────────────────────────────────

/** createCategory 的输入类型：仅名称必填，图标/颜色可选 */
export interface CreateCategoryInput {
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** 列出所有分类（按 id 升序，保持稳定顺序） */
export function listCategories(db: AppDatabase): Category[] {
  return db.select().from(categories).orderBy(asc(categories.id)).all();
}

/**
 * 新建分类，返回插入后的记录。
 * name 命中唯一约束时由底层 better-sqlite3 抛错（供路由层转 409）。
 */
export function createCategory(
  db: AppDatabase,
  input: CreateCategoryInput,
): Category {
  const rows = db
    .insert(categories)
    .values({
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? null,
    })
    .returning()
    .all();
  const created = rows[0];
  if (created === undefined) {
    throw new Error('createCategory 未返回插入结果');
  }
  return created;
}
