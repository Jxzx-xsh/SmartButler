/**
 * 食谱推荐路由（Fastify 插件）。
 *
 * 暴露 GET /api/recipes/recommend：按注入的 RecipeRecommender 基于家里食材推荐
 * 2-4 道家常菜。days 查询参数控制临期判定窗口（默认 3）。
 *
 * LM Studio 不可达时优雅降级（参考 routes/ai.ts）：
 * - connection/timeout → 503 LMSTUDIO_UNREACHABLE；
 * - bad_response → 502 LMSTUDIO_BAD_RESPONSE；
 * - 其余重抛交 app 的统一错误处理器。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import type { RecipeRecommender } from '../ai/recipe.js';
import { LmStudioError } from '../ai/errors.js';
import { recipeRecommendQuerySchema } from '../http/schemas.js';

/** 路由插件 opts：注入数据库与食谱推荐器。 */
export interface RecipeRoutesOptions extends FastifyPluginOptions {
  /** 数据库实例（取材用） */
  db: AppDatabase;
  /** 食谱推荐器（依赖注入，便于测试） */
  recommender: RecipeRecommender;
}

/** 注册食谱推荐路由。 */
export async function recipeRoutes(
  app: FastifyInstance,
  opts: RecipeRoutesOptions,
): Promise<void> {
  const { db, recommender } = opts;

  // GET /api/recipes/recommend — 基于家里食材推荐家常菜
  app.get('/api/recipes/recommend', async (request, reply) => {
    // query 校验失败抛 ZodError，由 app 统一错误处理转 400 VALIDATION_ERROR
    const { days } = recipeRecommendQuerySchema.parse(request.query);
    try {
      return await recommender.recommend(db, { days });
    } catch (err) {
      if (err instanceof LmStudioError) {
        // 连接/超时类错误视为 LM Studio 不可达，返回 503
        if (err.kind === 'connection' || err.kind === 'timeout') {
          return reply.code(503).send({
            error: {
              message: 'LM Studio 不可达，请确认本地模型已启动',
              code: 'LMSTUDIO_UNREACHABLE',
            },
          });
        }
        // 模型返回结构非法，返回 502
        if (err.kind === 'bad_response') {
          return reply.code(502).send({
            error: {
              message: 'LM Studio 返回无法解析',
              code: 'LMSTUDIO_BAD_RESPONSE',
            },
          });
        }
      }
      // 其余错误重抛交全局处理器
      throw err;
    }
  });
}
