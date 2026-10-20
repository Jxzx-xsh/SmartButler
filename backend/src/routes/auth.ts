/**
 * 访问鉴权路由（Fastify 插件）。
 *
 * 通过 opts 注入 AuthConfig。提供登录端点：校验访问密码后签发无状态 token。
 * 密码比对用 crypto.timingSafeEqual 防时序攻击；绝不记录/回显密码明文。
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AuthConfig } from '../auth/config.js';
import { isAuthEnabled } from '../auth/config.js';
import { issueToken } from '../auth/token.js';
import { loginBodySchema } from '../http/schemas.js';

/** 路由插件 opts：注入访问鉴权配置。 */
export interface AuthRoutesOptions extends FastifyPluginOptions {
  config: AuthConfig;
}

/**
 * 定长安全比对两个字符串：先 Buffer 化，长度不等直接判不符，
 * 不调 timingSafeEqual（长度不等会抛错）。
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** 注册访问鉴权路由。 */
export async function authRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const { config } = opts;

  // POST /api/auth/login — 校验访问密码后签发 token
  app.post('/api/auth/login', async (request, reply) => {
    // body 校验失败抛 ZodError，由 app 统一转 400 VALIDATION_ERROR
    const { password } = loginBodySchema.parse(request.body);

    // 鉴权未启用（无密码/关闭）时仍签发 token，保证前端登录流程一致
    if (!isAuthEnabled(config)) {
      return reply.send(makeTokenResponse(config));
    }

    // 密码比对（定长安全）：不符 → 401，绝不回显明文
    if (!safeEqual(password, config.password)) {
      return reply.code(401).send({
        error: { message: '访问密码错误', code: 'INVALID_PASSWORD' },
      });
    }

    return reply.send(makeTokenResponse(config));
  });
}

/** 签发 token 并计算 expiresAt（exp 毫秒），组装登录成功响应体。 */
function makeTokenResponse(config: AuthConfig): { token: string; expiresAt: number } {
  // 以同一 now 计算：token 的 exp 即 now+ttl，与 expiresAt 对齐
  const now = Date.now();
  const token = issueToken(config, now);
  return { token, expiresAt: now + config.tokenTtlMs };
}
