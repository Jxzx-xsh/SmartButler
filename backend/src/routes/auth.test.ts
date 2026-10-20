/** 登录路由集成测试（Fastify inject + 注入启用态 authConfig） */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { AuthConfig } from '../auth/config.js';
import { verifyToken } from '../auth/token.js';

const authConfig: AuthConfig = {
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

describe('POST /api/auth/login', () => {
  it('正确密码 → 200 带有效 token 与 expiresAt', async () => {
    app = buildApp({ db, authConfig });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'secret' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(typeof body.expiresAt).toBe('number');
    // token 应可被同密码校验通过
    expect(verifyToken(authConfig.password, body.token).valid).toBe(true);
  });

  it('错误密码 → 401 INVALID_PASSWORD', async () => {
    app = buildApp({ db, authConfig });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_PASSWORD');
  });

  it('缺 password → 400 VALIDATION_ERROR', async () => {
    app = buildApp({ db, authConfig });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});
