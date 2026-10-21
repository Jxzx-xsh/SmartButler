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
import type { ServerResponse } from 'node:http';

import type { AppDatabase } from '../db/client.js';
import type { RecipeRecommender } from '../ai/recipe.js';
import { LmStudioError } from '../ai/errors.js';
import {
  idParamSchema,
  recipeRecommendQuerySchema,
  saveRecipeBodySchema,
} from '../http/schemas.js';
import {
  listSavedRecipes,
  removeSavedRecipe,
  saveRecipe,
  type SaveRecipeInput,
} from '../db/recipe-repo.js';

/** 路由插件 opts：注入数据库与食谱推荐器。 */
export interface RecipeRoutesOptions extends FastifyPluginOptions {
  /** 数据库实例（取材用） */
  db: AppDatabase;
  /** 食谱推荐器（依赖注入，便于测试） */
  recommender: RecipeRecommender;
}

/** 向 SSE 连接写一条事件。 */
function sseSend(raw: ServerResponse, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 注册食谱推荐路由。 */
export async function recipeRoutes(
  app: FastifyInstance,
  opts: RecipeRoutesOptions,
): Promise<void> {
  const { db, recommender } = opts;

  // GET /api/recipes/recommend/stream — SSE 流式推荐：
  //   event: reasoning  data: {"delta":"思维链增量"}（多次）
  //   event: result     data: RecipeResult（一次，随后结束连接）
  //   event: fail       data: {"message":...,"code":...}（出错时）
  app.get('/api/recipes/recommend/stream', async (request, reply) => {
    const { days } = recipeRecommendQuerySchema.parse(request.query);

    // hijack 后由我们直接写原生响应，Fastify 不再接管
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 nginx/反代可能的缓冲，保证增量即时到达
      'X-Accel-Buffering': 'no',
    });
    // 立即刷出响应头，让前端尽早进入接收态
    raw.flushHeaders();

    try {
      const result = await recommender.recommendStream(db, { days }, {
        onReasoningDelta: (delta) => sseSend(raw, 'reasoning', { delta }),
      });
      sseSend(raw, 'result', result);
    } catch (err) {
      if (err instanceof LmStudioError) {
        if (err.kind === 'connection' || err.kind === 'timeout') {
          sseSend(raw, 'fail', {
            message: 'LM Studio 不可达，请确认本地模型已启动',
            code: 'LMSTUDIO_UNREACHABLE',
          });
        } else if (err.kind === 'bad_response') {
          sseSend(raw, 'fail', {
            message: 'LM Studio 返回无法解析',
            code: 'LMSTUDIO_BAD_RESPONSE',
          });
        } else {
          sseSend(raw, 'fail', { message: err.message, code: 'LMSTUDIO_ERROR' });
        }
      } else {
        sseSend(raw, 'fail', {
          message: err instanceof Error ? err.message : '推荐失败',
          code: 'INTERNAL',
        });
      }
    } finally {
      raw.end();
    }
  });

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

  // POST /api/recipes/saved — 收藏一条食谱，成功返回 201
  app.post('/api/recipes/saved', async (request, reply) => {
    const body = saveRecipeBodySchema.parse(request.body);
    // 仅透传已提供键，缺省交由仓储处理默认值
    const input: SaveRecipeInput = {
      name: body.name,
      ...(body.usedItems !== undefined ? { usedItems: body.usedItems } : {}),
      ...(body.missingItems !== undefined
        ? { missingItems: body.missingItems }
        : {}),
      ...(body.steps !== undefined ? { steps: body.steps } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
    };
    return reply.code(201).send(saveRecipe(db, input));
  });

  // GET /api/recipes/saved — 列出全部收藏（按收藏时间倒序）
  app.get('/api/recipes/saved', async () => {
    return listSavedRecipes(db);
  });

  // DELETE /api/recipes/saved/:id — 删除收藏，不存在 404，成功返回 204
  app.delete('/api/recipes/saved/:id', async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const ok = removeSavedRecipe(db, id);
    if (!ok) {
      return reply.code(404).send({
        error: { message: '收藏不存在', code: 'SAVED_RECIPE_NOT_FOUND' },
      });
    }
    return reply.code(204).send();
  });
}
