/** AI 路由集成测试（Fastify inject + 注入 mock LmStudioClient） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import { LmStudioError } from '../ai/errors.js';
import type { LmStudioClient } from '../ai/lmstudio.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 构造一个仅实现所需方法的 mock 客户端。 */
function makeMockClient(overrides: Partial<LmStudioClient> = {}): LmStudioClient {
  return {
    chatText: vi.fn(),
    chatTextJson: vi.fn(),
    chatVision: vi.fn(),
    embed: vi.fn(),
    listModels: vi.fn(),
    ...overrides,
  } as LmStudioClient;
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/ai/health', () => {
  it('listModels 成功时返回 200 和模型列表', async () => {
    const models = ['qwen/qwen3-4b-2507', 'qwen/qwen3-vl-8b'];
    const client = makeMockClient({
      listModels: vi.fn().mockResolvedValue(models),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reachable).toBe(true);
    expect(body.models).toEqual(models);
  });

  it('listModels 抛连接类 LmStudioError 时返回 503', async () => {
    const client = makeMockClient({
      listModels: vi
        .fn()
        .mockRejectedValue(new LmStudioError('无法连接 LM Studio', 'connection')),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/ai/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('LMSTUDIO_UNREACHABLE');
  });
});
