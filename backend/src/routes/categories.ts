/**
 * 分类路由（Fastify 插件）。
 *
 * 通过 opts 注入 db 实例。创建分类撞唯一约束时转 409。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import {
  createCategory,
  listCategories,
  type CreateCategoryInput,
} from '../db/repository.js';
import { createCategoryBodySchema } from '../http/schemas.js';

/** 路由插件 opts：注入数据库实例 */
export interface CategoriesRoutesOptions extends FastifyPluginOptions {
  db: AppDatabase;
}

/** 判断错误是否为 SQLite 唯一约束冲突 */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed/i.test(err.message)
  );
}

/** 注册分类路由 */
export async function categoriesRoutes(
  app: FastifyInstance,
  opts: CategoriesRoutesOptions,
): Promise<void> {
  const { db } = opts;

  // GET /api/categories — 列出所有分类
  app.get('/api/categories', async () => {
    return listCategories(db);
  });

  // POST /api/categories — 创建分类，name 撞唯一约束返回 409
  app.post('/api/categories', async (request, reply) => {
    const body = createCategoryBodySchema.parse(request.body);
    const input: CreateCategoryInput = {
      name: body.name,
      ...(body.icon !== undefined ? { icon: body.icon } : {}),
      ...(body.color !== undefined ? { color: body.color } : {}),
    };
    try {
      const created = createCategory(db, input);
      return reply.code(201).send(created);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return reply.code(409).send({
          error: {
            message: `分类名称「${input.name}」已存在`,
            code: 'CATEGORY_NAME_CONFLICT',
          },
        });
      }
      throw err;
    }
  });
}
