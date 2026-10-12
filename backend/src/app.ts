/**
 * Fastify 应用工厂。
 *
 * buildApp(options?) 返回配置好的 Fastify 实例：
 * - 支持注入数据库实例（默认用 client.ts 的 db，测试时可传独立内存库）；
 * - 注册 @fastify/cors（后续 PWA 跨域需要）；
 * - 注册物品 / 分类路由；
 * - 统一错误处理：ZodError → 400，其余按状态码或 500，错误体统一为 { error: { message, code? } }。
 *
 * 同步构建、返回 FastifyInstance，便于测试用 inject() 调用，无需真实监听端口。
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';

import { db as defaultDb, type AppDatabase } from './db/client.js';
import { itemsRoutes } from './routes/items.js';
import { categoriesRoutes } from './routes/categories.js';

/** buildApp 选项 */
export interface BuildAppOptions {
  /** 注入的数据库实例，缺省使用 client.ts 的默认 db */
  db?: AppDatabase;
}

/** 把 zod 的 issues 概要成一句可读信息 */
function summarizeZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** 构建并返回配置好的 Fastify 实例 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const db = options.db ?? defaultDb;

  const app = Fastify({ logger: false });

  // CORS：开放所有来源（局域网内 PWA / 采集端访问）
  app.register(cors, { origin: true });

  // 注入 db 注册业务路由
  app.register(itemsRoutes, { db });
  app.register(categoriesRoutes, { db });

  // 统一错误处理（error 由 Fastify 保证为 FastifyError，含 message/code/statusCode）
  app.setErrorHandler(
    (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      // zod 校验失败 → 400
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            message: summarizeZodError(error),
            code: 'VALIDATION_ERROR',
          },
        });
      }

      // Fastify 内置 body 解析/校验错误（含 statusCode）透传
      const statusCode = error.statusCode;
      if (
        typeof statusCode === 'number' &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
        return reply.code(statusCode).send({
          error: { message: error.message, code: error.code },
        });
      }

      // 其余按 500 处理
      app.log.error(error);
      return reply.code(500).send({
        error: { message: '服务器内部错误' },
      });
    },
  );

  return app;
}
