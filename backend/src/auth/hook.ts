/**
 * 全局 onRequest 鉴权钩子工厂。
 *
 * onRequest 在路由匹配之后触发，request.routeOptions.url 为匹配到的路由模式
 * （404 时为 undefined）。豁免判断对 routeOptions.url 做精确相等匹配，绝不对
 * request.url（原始含 query、可被 .. 构造）做前缀匹配，以防 /api/auth/login/../items
 * 之类前缀绕过。鉴权未启用时全放行；校验失败统一回 401 UNAUTHORIZED。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthConfig } from './config.js';
import { isAuthEnabled } from './config.js';
import { verifyToken } from './token.js';

/** 从 Authorization 头取 Bearer token（无则返回空字符串）。 */
function extractBearer(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return '';
  }
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) {
    return '';
  }
  return header.slice(prefix.length).trim();
}

/** 从 query.token 取 token（无/非字符串则返回空字符串）。 */
function extractQueryToken(request: FastifyRequest): string {
  const query = request.query as { token?: unknown };
  return typeof query.token === 'string' ? query.token : '';
}

/**
 * 构造全局 onRequest 鉴权处理器。
 * @param config 访问鉴权配置（含密码与开关）。
 */
export function createAuthHook(
  config: AuthConfig,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    // 鉴权未启用（无密码/关闭）：全放行
    if (!isAuthEnabled(config)) {
      return;
    }

    const routeUrl = request.routeOptions.url;
    // 未匹配到路由（404）：交 Fastify 处理，不拦截
    if (routeUrl === undefined) {
      return;
    }
    // 非 /api 前缀：放行（静态/其它）
    if (!routeUrl.startsWith('/api')) {
      return;
    }

    const method = request.method;

    // 豁免端点（精确相等匹配）：登录与健康检查
    if (method === 'POST' && routeUrl === '/api/auth/login') {
      return;
    }
    if (method === 'GET' && routeUrl === '/api/health') {
      return;
    }

    // 取 token：优先 Authorization Bearer；
    // 对 stream/snapshot（<img> 直用、无法带头）额外允许 query.token
    let token = extractBearer(request);
    if (
      token === '' &&
      method === 'GET' &&
      (routeUrl === '/api/capture/stream' || routeUrl === '/api/capture/snapshot')
    ) {
      token = extractQueryToken(request);
    }

    // token 为空或校验不通过 → 401
    if (token === '' || !verifyToken(config.password, token).valid) {
      await reply.code(401).send({
        error: { message: '未授权访问', code: 'UNAUTHORIZED' },
      });
      return;
    }
  };
}
