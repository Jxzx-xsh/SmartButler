/**
 * 物品消耗 / 用完登记路由（Fastify 插件）。
 *
 * 复用仓储层 consumeItem / listConsumptionHistory，不绕过仓储写裸 SQL。
 * 通过插件 opts 注入 db 实例，便于测试传入独立内存库。
 * 校验用 zod（见 http/schemas.ts），校验失败抛出的 ZodError 冒泡到 app 统一错误处理转 400。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import {
  consumeItem,
  getItem,
  listConsumptionHistory,
  type ConsumeItemOptions,
} from '../db/repository.js';
import {
  consumeBodySchema,
  consumptionHistoryQuerySchema,
  idParamSchema,
} from '../http/schemas.js';

/** 路由插件 opts：注入数据库实例 */
export interface ConsumptionRoutesOptions extends FastifyPluginOptions {
  db: AppDatabase;
}

/** 注册物品消耗 / 用完登记路由。 */
export async function consumptionRoutes(
  app: FastifyInstance,
  opts: ConsumptionRoutesOptions,
): Promise<void> {
  const { db } = opts;

  // POST /api/items/:id/consume — 登记消耗/用完，减库存或删除并留痕
  app.post('/api/items/:id/consume', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = consumeBodySchema.parse(request.body ?? {});

    // 先判存在性：不存在返回 404（与 items 路由一致）
    const existing = getItem(db, id);
    if (existing === null) {
      return reply.code(404).send({
        error: { message: '物品不存在', code: 'ITEM_NOT_FOUND' },
      });
    }

    const consumeOpts: ConsumeItemOptions = {
      ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
      ...(body.eventType !== undefined ? { eventType: body.eventType } : {}),
    };
    const item = consumeItem(db, id, consumeOpts);
    const depleted = item === null;
    return {
      item,
      consumed: true,
      depleted,
      message: depleted ? '已用完并移除' : '已登记消耗',
    };
  });

  // GET /api/consumption/history — 消耗历史，按记录时间降序
  app.get('/api/consumption/history', async (request) => {
    const query = consumptionHistoryQuerySchema.parse(request.query);
    return listConsumptionHistory(db, {
      limit: query.limit,
      ...(query.itemId !== undefined ? { itemId: query.itemId } : {}),
    });
  });
}
