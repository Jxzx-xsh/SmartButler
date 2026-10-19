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
    app = buildWith({ recommend: vi.fn().mockResolvedValue(result) });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it('recommender 抛 connection LmStudioError → 503 LMSTUDIO_UNREACHABLE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('无法连接', 'connection')),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LMSTUDIO_UNREACHABLE');
  });

  it('recommender 抛 timeout LmStudioError → 503 LMSTUDIO_UNREACHABLE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('超时', 'timeout')),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LMSTUDIO_UNREACHABLE');
  });

  it('recommender 抛 bad_response LmStudioError → 502 LMSTUDIO_BAD_RESPONSE', async () => {
    app = buildWith({
      recommend: vi.fn().mockRejectedValue(new LmStudioError('结构非法', 'bad_response')),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('LMSTUDIO_BAD_RESPONSE');
  });

  it('days 查询参数透传给 recommender.recommend', async () => {
    const recommend = vi.fn().mockResolvedValue({ recipes: [] } satisfies RecipeResult);
    app = buildWith({ recommend });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/recipes/recommend?days=7' });

    expect(recommend).toHaveBeenCalledWith(db, { days: 7 });
  });

  it('缺省 days 时按默认 3 透传', async () => {
    const recommend = vi.fn().mockResolvedValue({ recipes: [] } satisfies RecipeResult);
    app = buildWith({ recommend });
    await app.ready();

    await app.inject({ method: 'GET', url: '/api/recipes/recommend' });

    expect(recommend).toHaveBeenCalledWith(db, { days: 3 });
  });
});
