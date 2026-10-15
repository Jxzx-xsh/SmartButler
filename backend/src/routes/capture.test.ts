/** 采集网关路由集成测试（Fastify inject + 注入 mock 网关持有者） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { CaptureStatus } from '../capture/gateway.js';
import type { CaptureGatewayHolder } from './capture.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 一个基础状态模板（已配置源，connected，带若干指标）。 */
function makeStatus(overrides: Partial<CaptureStatus> = {}): CaptureStatus {
  return {
    state: 'connected',
    sourceUrl: 'http://192.168.1.10:8080/video',
    fps: 2,
    lastFrameAt: null,
    frameCount: 0,
    audioBytes: 0,
    reconnectAttempts: 0,
    ...overrides,
  };
}

/**
 * 构造仅实现所需方法的 mock 网关持有者。
 * getStatus 默认返回传入的 status（可被单测覆盖以模拟不同场景）。
 */
function makeMockGateway(
  overrides: Partial<CaptureGatewayHolder> = {},
): CaptureGatewayHolder {
  return {
    setSource: vi.fn(),
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue(makeStatus()),
    getLatestFrame: vi.fn().mockReturnValue(null),
    ...overrides,
  } as CaptureGatewayHolder;
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/capture/status', () => {
  it('已配置源时返回 200 且 configured 为 true', async () => {
    const gateway = makeMockGateway({
      getStatus: vi.fn().mockReturnValue(makeStatus({ frameCount: 5 })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.state).toBe('connected');
    expect(body.frameCount).toBe(5);
  });

  it('未配置源时返回 200 且 configured 为 false', async () => {
    const gateway = makeMockGateway({
      getStatus: vi
        .fn()
        .mockReturnValue(makeStatus({ state: 'stopped', sourceUrl: '' })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(false);
    expect(body.state).toBe('stopped');
  });
});

describe('POST /api/capture/start', () => {
  it('合法 URL 返回 200 并调用 setSource + start', async () => {
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/capture/start',
      payload: { url: 'http://192.168.1.10:8080/video', fps: 3 },
    });

    expect(res.statusCode).toBe(200);
    expect(gateway.setSource).toHaveBeenCalledWith(
      'http://192.168.1.10:8080/video',
      3,
    );
    expect(gateway.start).toHaveBeenCalledTimes(1);
    // 返回体为 getStatus() 结果
    expect(res.json().state).toBe('connected');
  });

  it('非法 URL 返回 400 VALIDATION_ERROR 且不调用 start', async () => {
    const gateway = makeMockGateway();
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/capture/start',
      payload: { url: 'not-a-url' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(gateway.start).not.toHaveBeenCalled();
  });
});

describe('POST /api/capture/stop', () => {
  it('调用 stop 并返回 200 和最新状态', async () => {
    const gateway = makeMockGateway({
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(makeStatus({ state: 'stopped' })),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/capture/stop' });
    expect(res.statusCode).toBe(200);
    expect(gateway.stop).toHaveBeenCalledTimes(1);
    expect(res.json().state).toBe('stopped');
  });
});

describe('GET /api/capture/snapshot', () => {
  it('有帧时返回 image/jpeg 二进制', async () => {
    // 构造一个最小 JPEG 字节（SOI...EOI），仅用于断言透传
    const frame = Buffer.from([0xff, 0xd8, 0x00, 0x11, 0xff, 0xd9]);
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(frame),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/snapshot' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload.equals(frame)).toBe(true);
  });

  it('无帧时返回 503 NO_FRAME', async () => {
    const gateway = makeMockGateway({
      getLatestFrame: vi.fn().mockReturnValue(null),
    });
    app = buildApp({ db, captureGateway: gateway });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/capture/snapshot' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('NO_FRAME');
  });
});
