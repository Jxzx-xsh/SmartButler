/** 全局鉴权钩子集成测试（Fastify inject + 注入启用态 authConfig） */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { AuthConfig } from './config.js';
import { issueToken } from './token.js';

const enabledConfig: AuthConfig = {
  password: 'secret',
  enabled: true,
  tokenTtlMs: 60000,
};

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

/** 便捷：构造启用态 app */
function buildEnabled(config: AuthConfig = enabledConfig): void {
  app = buildApp({ db, authConfig: config });
}

describe('启用态鉴权钩子', () => {
  it('无 token 打受保护端点 GET /api/items → 401 UNAUTHORIZED', async () => {
    buildEnabled();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('带有效 Bearer token → 非 401', async () => {
    buildEnabled();
    await app.ready();
    const token = issueToken(enabledConfig);
    const res = await app.inject({
      method: 'GET',
      url: '/api/items',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('豁免端点 POST /api/auth/login 与 GET /api/health 免 token → 非 401', async () => {
    buildEnabled();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'secret' },
    });
    expect(login.statusCode).not.toBe(401);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
  });

  it('GET /api/capture/snapshot 带有效 query token → 非 401，无 token → 401', async () => {
    buildEnabled();
    await app.ready();
    const token = issueToken(enabledConfig);

    const withToken = await app.inject({
      method: 'GET',
      url: `/api/capture/snapshot?token=${encodeURIComponent(token)}`,
    });
    expect(withToken.statusCode).not.toBe(401);

    const without = await app.inject({ method: 'GET', url: '/api/capture/snapshot' });
    expect(without.statusCode).toBe(401);
    expect(without.json().error.code).toBe('UNAUTHORIZED');
  });

  it('过期 token → 401', async () => {
    buildEnabled();
    await app.ready();
    // 用过去的 now 签发使其立即过期
    const expired = issueToken(enabledConfig, Date.now() - enabledConfig.tokenTtlMs - 1000);
    const res = await app.inject({
      method: 'GET',
      url: '/api/items',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('路径穿透不绕过：/api/auth/login/../items 无法借豁免访问 → 401 或 404', async () => {
    buildEnabled();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/login/../items',
    });
    // 解析到 /api/items（需鉴权，401）或未匹配（404），绝不因前缀豁免放行业务数据
    expect([401, 404]).toContain(res.statusCode);
  });
});

describe('鉴权未启用', () => {
  it('enabled=false 时无 token 打受保护端点 → 非 401（全放行）', async () => {
    app = buildApp({
      db,
      authConfig: { password: 'secret', enabled: false, tokenTtlMs: 60000 },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).not.toBe(401);
  });

  it('密码为空时无 token 打受保护端点 → 非 401（全放行）', async () => {
    app = buildApp({
      db,
      authConfig: { password: '', enabled: true, tokenTtlMs: 60000 },
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).not.toBe(401);
  });
});
