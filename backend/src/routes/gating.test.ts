/** 门控路由集成测试（Fastify inject + 注入 mock 门控协调器） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { GatingController, GatingStats } from '../gating/gating.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 一个基础统计模板（可被单测覆盖以模拟不同场景）。 */
function makeStats(overrides: Partial<GatingStats> = {}): GatingStats {
  return {
    framesProcessed: 0,
    motionEvents: 0,
    audioBytesProcessed: 0,
    audioEvents: 0,
    lastMotionAt: null,
    lastAudioAt: null,
    speaking: false,
    ...overrides,
  };
}

/**
 * 构造仅实现所需方法的 mock 门控协调器。
 * getStats 默认返回传入的 stats（可被单测覆盖）。
 */
function makeMockController(
  overrides: Partial<GatingController> = {},
): GatingController {
  return {
    processFrame: vi.fn(),
    processAudio: vi.fn(),
    onVideoMotion: vi.fn(),
    onAudioActivity: vi.fn(),
    getStats: vi.fn().mockReturnValue(makeStats()),
    ...overrides,
  } as GatingController;
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/gating/status', () => {
  it('返回 200 且透传 getStats 的字段', async () => {
    const controller = makeMockController({
      getStats: vi.fn().mockReturnValue(
        makeStats({
          framesProcessed: 42,
          motionEvents: 3,
          audioBytesProcessed: 1024,
          audioEvents: 2,
          lastMotionAt: 111,
          lastAudioAt: 222,
          speaking: false,
        }),
      ),
    });
    app = buildApp({ db, gatingController: controller });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/gating/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.framesProcessed).toBe(42);
    expect(body.motionEvents).toBe(3);
    expect(body.audioBytesProcessed).toBe(1024);
    expect(body.audioEvents).toBe(2);
    expect(body.lastMotionAt).toBe(111);
    expect(body.lastAudioAt).toBe(222);
    expect(body.speaking).toBe(false);
    // 久远的 lastMotionAt 且未说话 → 非活动
    expect(body.active).toBe(false);
  });

  it('正在说话时 active 为 true', async () => {
    const controller = makeMockController({
      getStats: vi.fn().mockReturnValue(makeStats({ speaking: true })),
    });
    app = buildApp({ db, gatingController: controller });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/gating/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
  });

  it('最近运动事件落在近窗口内时 active 为 true', async () => {
    const controller = makeMockController({
      getStats: vi
        .fn()
        .mockReturnValue(makeStats({ lastMotionAt: Date.now() })),
    });
    app = buildApp({ db, gatingController: controller });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/gating/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
  });
});
