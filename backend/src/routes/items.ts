/**
 * 物品管理路由（Fastify 插件）。
 *
 * 复用 Task 1 的仓储函数与到期纯函数，不绕过仓储写裸 SQL、不重复实现到期逻辑。
 * 通过插件 opts 注入 db 实例，便于测试传入独立内存库。
 * 校验用 zod（见 http/schemas.ts），校验失败抛出的 ZodError 冒泡到 app 统一错误处理转 400。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import {
  createItem,
  deleteItem,
  getItem,
  listExpiringItems,
  listItems,
  updateItem,
  type CreateItemInput,
  type UpdateItemPatch,
} from '../db/repository.js';
import { computeExpiryDate, daysUntilExpiry } from '../domain/expiry.js';
import type { Item } from '../db/schema.js';
import {
  createItemBodySchema,
  expiringQuerySchema,
  idParamSchema,
  listItemsQuerySchema,
  patchItemBodySchema,
} from '../http/schemas.js';

/** 路由插件 opts：注入数据库实例 */
export interface ItemsRoutesOptions extends FastifyPluginOptions {
  db: AppDatabase;
}

/** 给物品附加计算字段 daysUntilExpiry（到期剩余天数，无到期日为 null） */
function withComputed(item: Item): Item & { daysUntilExpiry: number | null } {
  return { ...item, daysUntilExpiry: daysUntilExpiry(item) };
}

/**
 * 注册物品管理路由。
 * 注意：/api/items/expiring 必须在 /api/items/:id 之前声明，否则 "expiring" 会被当作 :id。
 */
export async function itemsRoutes(
  app: FastifyInstance,
  opts: ItemsRoutesOptions,
): Promise<void> {
  const { db } = opts;

  // GET /api/items — 列表，支持 categoryId / location / confirmed 过滤，附带 daysUntilExpiry
  app.get('/api/items', async (request) => {
    const filter = listItemsQuerySchema.parse(request.query);
    const rows = listItems(db, filter);
    return rows.map(withComputed);
  });

  // GET /api/items/expiring — N 天内到期（含已过期），按到期日升序。核心到期提醒端点
  app.get('/api/items/expiring', async (request) => {
    const { days } = expiringQuerySchema.parse(request.query);
    const rows = listExpiringItems(db, days);
    return rows.map(withComputed);
  });

  // GET /api/items/:id — 单个物品，不存在 404
  app.get('/api/items/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const item = getItem(db, id);
    if (item === null) {
      return reply.code(404).send({
        error: { message: '物品不存在', code: 'ITEM_NOT_FOUND' },
      });
    }
    return withComputed(item);
  });

  // POST /api/items — 创建，成功返回 201
  app.post('/api/items', async (request, reply) => {
    const body = createItemBodySchema.parse(request.body);
    // zod 解析后类型精确，字段与 CreateItemInput 对齐
    const input: CreateItemInput = {
      name: body.name,
      ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
      ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.purchaseDate !== undefined
        ? { purchaseDate: body.purchaseDate }
        : {}),
      ...(body.shelfLifeDays !== undefined
        ? { shelfLifeDays: body.shelfLifeDays }
        : {}),
      ...(body.expiryDate !== undefined ? { expiryDate: body.expiryDate } : {}),
      ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    };
    const created = createItem(db, input);
    return reply.code(201).send(withComputed(created));
  });

  // PATCH /api/items/:id — 部分更新，不存在 404
  app.patch('/api/items/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = patchItemBodySchema.parse(request.body);

    const patch: UpdateItemPatch = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
      ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.purchaseDate !== undefined
        ? { purchaseDate: body.purchaseDate }
        : {}),
      ...(body.shelfLifeDays !== undefined
        ? { shelfLifeDays: body.shelfLifeDays }
        : {}),
      ...(body.expiryDate !== undefined ? { expiryDate: body.expiryDate } : {}),
      ...(body.confirmed !== undefined ? { confirmed: body.confirmed } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    };

    // 领域策略：改动 purchaseDate/shelfLifeDays 且未显式给 expiryDate 时重算到期日。
    // 仓储 updateItem 刻意不含此策略，故在路由层补齐（取当前记录补全缺失值）。
    const touchesExpiryInputs =
      body.purchaseDate !== undefined || body.shelfLifeDays !== undefined;
    if (touchesExpiryInputs && body.expiryDate === undefined) {
      const current = getItem(db, id);
      if (current === null) {
        return reply.code(404).send({
          error: { message: '物品不存在', code: 'ITEM_NOT_FOUND' },
        });
      }
      const purchaseDate = patch.purchaseDate ?? current.purchaseDate;
      const shelfLifeDays = patch.shelfLifeDays ?? current.shelfLifeDays;
      patch.expiryDate = computeExpiryDate(purchaseDate, shelfLifeDays);
    }

    const updated = updateItem(db, id, patch);
    if (updated === null) {
      return reply.code(404).send({
        error: { message: '物品不存在', code: 'ITEM_NOT_FOUND' },
      });
    }
    return withComputed(updated);
  });

  // DELETE /api/items/:id — 删除，不存在 404，成功返回 204
  app.delete('/api/items/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const ok = deleteItem(db, id);
    if (!ok) {
      return reply.code(404).send({
        error: { message: '物品不存在', code: 'ITEM_NOT_FOUND' },
      });
    }
    return reply.code(204).send();
  });
}
