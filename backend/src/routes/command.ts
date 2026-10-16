/**
 * 指令路由（Fastify 插件）。
 *
 * 暴露 POST /api/command：接收一句中文指令，经注入的 CommandRouter 分类并路由
 * （立即执行 / 物品记录 / 查询 / 未知），原样下发路由结果。
 *
 * body 校验用 http/schemas.ts 的 commandBodySchema；校验失败抛 ZodError，
 * 由 app.ts 的 setErrorHandler 统一转 400 VALIDATION_ERROR。错误体风格与现有路由一致。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { CommandRouter } from '../commands/command-router.js';
import { commandBodySchema } from '../http/schemas.js';

/** 路由插件 opts：注入指令路由器。 */
export interface CommandRoutesOptions extends FastifyPluginOptions {
  /** 指令路由器（依赖注入，便于测试） */
  router: CommandRouter;
}

/** 注册指令路由。 */
export async function commandRoutes(
  app: FastifyInstance,
  opts: CommandRoutesOptions,
): Promise<void> {
  const { router } = opts;

  // POST /api/command — 分类并路由一句中文指令
  app.post('/api/command', async (request, reply) => {
    // body 校验失败抛 ZodError，由 app 统一错误处理转 400 VALIDATION_ERROR
    const { text, source } = commandBodySchema.parse(request.body);
    const result = await router.route(text, source ? { source } : {});
    return reply.send(result);
  });
}
