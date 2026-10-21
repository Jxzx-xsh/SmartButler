/** 食谱推荐路由集成测试（Fastify inject + 独立内存库 + 注入 fake recommender） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import { LmStudioError } from '../ai/errors.js';
import type { RecipeRecommender, RecipeResult } from '../ai/recipe.js';

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

/** 构造注入 recommender 的 app（每个用例可自定 recommend 行为）。 */
function buildWith(recommender: RecipeRecommender): FastifyInstance {
  return buildApp({ db, recipeRecommender: recommender });
}

describe('GET /api/recipes/recommend', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('注入返回合法结果的 fake recommender → 200 + recipes', async () => {
    const result: RecipeResult = {
      recipes: [{ name: '番茄炒蛋', usedItems: ['番茄', '鸡蛋'] }],
    };
    app = buildWith({ recommend: vi.fn().mockResolvedValue(result), recommendStream: vi.fn() });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it('recommender 抛 connection LmStudioError → 503 LMSTUDIO_UNREACHABLE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('无法连接', 'connection')),
      recommendStream: vi.fn(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LMSTUDIO_UNREACHABLE');
  });

  it('recommender 抛 timeout LmStudioError → 503 LMSTUDIO_UNREACHABLE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('超时', 'timeout')),
      recommendStream: vi.fn(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LMSTUDIO_UNREACHABLE');
  });

  it('recommender 抛 bad_response LmStudioError → 502 LMSTUDIO_BAD_RESPONSE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('结构非法', 'bad_response')),
      recommendStream: vi.fn(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('LMSTUDIO_BAD_RESPONSE');
  });

  it('days 查询参数透传给 recommender.recommend', async () => {
    const recommend = vi.fn().mockResolvedValue({ recipes: [] } satisfies RecipeResult);
    app = buildWith({ recommend, recommendStream: vi.fn() });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/recipes/recommend?days=7' });

    expect(recommend).toHaveBeenCalledWith(db, { days: 7 });
  });

  it('缺省 days 时按默认 3 透传', async () => {
    const recommend = vi.fn().mockResolvedValue({ recipes: [] } satisfies RecipeResult);
    app = buildWith({ recommend, recommendStream: vi.fn() });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(recommend).toHaveBeenCalledWith(db, { days: 3 });
  });
});

describe('收藏食谱端点 /api/recipes/saved', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // saved 端点不依赖 recommender，用占位 fake 构造 app
    app = buildWith({ recommend: vi.fn(), recommendStream: vi.fn() });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('POST 合法 body → 201 且含 id/createdAt、usedItems 为数组', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/recipes/saved',
      payload: { name: '番茄炒蛋', usedItems: ['番茄', '鸡蛋'] },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTypeOf('number');
    expect(body.createdAt).toBeTypeOf('number');
    expect(body.usedItems).toEqual(['番茄', '鸡蛋']);
  });

  it('POST name 空 → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/recipes/saved',
      payload: { name: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET 空库 → 200 []', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/recipes/saved' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST 两条后 GET → 200 长度 2 且 createdAt 倒序', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/recipes/saved',
      payload: { name: '早菜' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/recipes/saved',
      payload: { name: '晚菜' },
    });

    const res = await app.inject({ method: 'GET', url: '/api/recipes/saved' });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(2);
    // 后收藏的在前（createdAt 倒序，同刻按 id 倒序兜底）
    expect(rows[0].name).toBe('晚菜');
    expect(rows[1].name).toBe('早菜');
  });

  it('DELETE 已存在 → 204 且随后 GET 少一条', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/recipes/saved',
      payload: { name: '番茄炒蛋' },
    });
    const { id } = created.json();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/recipes/saved/${id}`,
    });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/recipes/saved' });
    expect(list.json()).toHaveLength(0);
  });

  it('DELETE 不存在 → 404 SAVED_RECIPE_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/recipes/saved/9999',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SAVED_RECIPE_NOT_FOUND');
  });
});
