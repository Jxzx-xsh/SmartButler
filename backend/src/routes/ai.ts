/**
 * AI 路由（Fastify 插件）。
 *
 * 通过 opts 注入 LmStudioClient。目前提供健康检查端点，
 * 后续语音/视觉/指令路由可在此基础上扩展。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { LmStudioClient } from '../ai/lmstudio.js';
import { LmStudioError } from '../ai/errors.js';

/** 路由插件 opts：注入 LM Studio 客户端。 */
export interface AiRoutesOptions extends FastifyPluginOptions {
  client: LmStudioClient;
}

/** 注册 AI 路由。 */
export async function aiRoutes(
  app: FastifyInstance,
  opts: AiRoutesOptions,
): Promise<void> {
  const { client } = opts;

  // GET /api/ai/health — 探测 LM Studio 是否可达并返回可用模型
  app.get('/api/ai/health', async (_request, reply) => {
    try {
      const models = await client.listModels();
      return { reachable: true, models };
    } catch (err) {
      // 连接类错误视为不可达，返回 503；沿用统一错误体风格
      if (err instanceof LmStudioError && err.kind === 'connection') {
        return reply.code(503).send({
          error: {
            message: 'LM Studio 不可达',
            code: 'LMSTUDIO_UNREACHABLE',
          },
        });
      }
      throw err;
    }
  });
}
