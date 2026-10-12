/** 分类路由集成测试（Fastify inject + 独立内存库） */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';

let app: FastifyInstance;
let db: AppDatabase;

beforeEach(async () => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
  app = buildApp({ db });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/categories', () => {
  it('列出所有分类', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '乳制品' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '蔬果' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((c: { name: string }) => c.name)).toEqual([
      '乳制品',
      '蔬果',
    ]);
  });
});

describe('POST /api/categories', () => {
  it('创建分类返回 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '日用品', icon: 'box', color: '#D9B38C' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('日用品');
    expect(body.id).toBeTypeOf('number');
  });

  it('重复 name 命中唯一约束返回 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '乳制品' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: '乳制品' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CATEGORY_NAME_CONFLICT');
  });

  it('缺少 name 返回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
