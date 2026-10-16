/**
 * Home Assistant 路由（Fastify 插件）。
 *
 * 职责：对外暴露 HA 集成端点——状态探测、读取实体状态、调用服务、临期暴露。
 * 依赖经 opts 注入（client / db / config / 可选 subscriber），便于测试注入 mock，
 * 镜像 src/routes/ai.ts、src/routes/capture.ts 的依赖注入与错误体风格。
 *
 * 未配置降级：HA 未配置（isHaConfigured 为假）时，/api/ha/status 返回
 * { configured:false, enabled:false }（200），其余端点返回 503 HA_NOT_CONFIGURED，
 * 绝不触网、绝不崩溃。
 *
 * 错误映射（haErrorToReply）：HaError 按 kind 映射 HTTP 状态——
 *   connection/config → 503、auth → 502、not_found → 404、bad_response → 502，
 * 统一错误体 { error: { message, code } }，code 形如 HA_<KIND>；
 * 非 HaError 透传给 app.ts 的 setErrorHandler（ZodError → 400 VALIDATION_ERROR，其余 500）。
 *
 * 令牌安全：错误体与响应体均不含令牌（HaError.message 本就不含令牌，此处仅透传 message）。
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client.js';
import type { HaClient } from '../ha/ha-client.js';
import { isHaConfigured, type HaConfig } from '../ha/config.js';
import { HaError } from '../ha/errors.js';
import type { HaEventSubscriber } from '../ha/ha-events.js';
import { exposeExpiringToHa } from '../ha/ha-expose.js';

/** 路由插件 opts：注入 HA 客户端、数据库、配置与可选 WS 订阅器。 */
export interface HaRoutesOptions extends FastifyPluginOptions {
  client: HaClient;
  db: AppDatabase;
  config: HaConfig;
  subscriber?: HaEventSubscriber;
}

/**
 * 把 HaError 按 kind 映射为统一错误响应；非 HaError 则 rethrow（交由全局错误处理）。
 * 消息直接透传 HaError.message（其构造处已保证不含令牌）。
 */
function haErrorToReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HaError) {
    const kind = err.kind;
    let status: number;
    switch (kind) {
      case 'connection':
      case 'config':
        status = 503;
        break;
      case 'auth':
        status = 502;
        break;
      case 'not_found':
        status = 404;
        break;
      case 'bad_response':
        status = 502;
        break;
      default:
        status = 502;
    }
    return reply.code(status).send({
      error: { message: err.message, code: `HA_${kind.toUpperCase()}` },
    });
  }
  // 非 HaError：交给上层统一错误处理
  throw err;
}

/** 未配置时的 503 错误体。 */
function notConfiguredReply(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: { message: 'Home Assistant 未配置', code: 'HA_NOT_CONFIGURED' },
  });
}

/** 注册 HA 路由。 */
export async function haRoutes(
  app: FastifyInstance,
  opts: HaRoutesOptions,
): Promise<void> {
  const { client, db, config, subscriber } = opts;

  // GET /api/ha/status — 配置/可达/连接状态探测（未配置也返回 200）
  app.get('/api/ha/status', async (_request, _reply) => {
    if (!isHaConfigured(config)) {
      return { configured: false, enabled: false };
    }
    // 探测可达性：连接/鉴权类错误视为不可达（false），其余错误上抛
    const reachable = await client
      .ping()
      .then(() => true)
      .catch((e: unknown) => {
        if (e instanceof HaError && (e.kind === 'connection' || e.kind === 'auth')) {
          return false;
        }
        throw e;
      });
    const connected = subscriber?.isConnected() ?? false;
    return { configured: true, enabled: true, reachable, connected };
  });

  // GET /api/ha/states — 读取全部实体状态
  app.get('/api/ha/states', async (_request, reply) => {
    if (!isHaConfigured(config)) {
      return notConfiguredReply(reply);
    }
    try {
      return await client.getStates();
    } catch (err) {
      return haErrorToReply(reply, err);
    }
  });

  // POST /api/ha/service — 调用 HA 服务
  app.post('/api/ha/service', async (request, reply) => {
    if (!isHaConfigured(config)) {
      return notConfiguredReply(reply);
    }
    const body = z
      .object({
        domain: z.string().min(1),
        service: z.string().min(1),
        entity_id: z.string().min(1),
      })
      .parse(request.body);
    try {
      return await client.callService(body.domain, body.service, {
        entity_id: body.entity_id,
      });
    } catch (err) {
      return haErrorToReply(reply, err);
    }
  });

  // POST /api/ha/expose-expiring — 把临期统计暴露为 HA 传感器
  app.post('/api/ha/expose-expiring', async (request, reply) => {
    if (!isHaConfigured(config)) {
      return notConfiguredReply(reply);
    }
    const body = z
      .object({ days: z.number().int().positive().optional() })
      .parse(request.body ?? {});
    try {
      return await exposeExpiringToHa(client, db, body.days ?? 3);
    } catch (err) {
      return haErrorToReply(reply, err);
    }
  });
}
