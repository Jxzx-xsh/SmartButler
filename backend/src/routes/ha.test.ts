/**
 * HA 路由集成测试（Fastify inject + 注入 mock HaClient + 内存库）。
 *
 * /api/ha/status 的 configured 由 buildApp 内部 loadHaConfig() 读 process.env 决定，
 * 故用 vi.stubEnv 控制 HA_BASE_URL/HA_TOKEN 以切换 configured 分支（afterEach 还原）。
 * 全程注入 mock client，绝不触真实 HA。并断言任何响应体/错误体都不含令牌。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';
import { MS_PER_DAY } from '../domain/expiry.js';
import { buildApp } from '../app.js';
import { HaError } from '../ha/errors.js';
import type { HaClient } from '../ha/ha-client.js';
import { EXPIRING_SENSOR_ENTITY } from '../ha/ha-expose.js';

const TOKEN = 'secret-ha-token-should-never-leak';

let app: FastifyInstance;
let db: AppDatabase;

/** 构造 mock HaClient（所有方法 vi.fn，可按需覆盖）。 */
function makeMockHaClient(overrides: Partial<HaClient> = {}): HaClient {
  return {
    ping: vi.fn(),
    getStates: vi.fn(),
    getState: vi.fn(),
    callService: vi.fn(),
    turnOn: vi.fn(),
    turnOff: vi.fn(),
    setState: vi.fn(),
    ...overrides,
  } as HaClient;
}

/** 配置 HA 环境（已配置分支）。 */
function stubConfigured(): void {
  vi.stubEnv('HA_BASE_URL', 'http://ha.test:8123');
  vi.stubEnv('HA_TOKEN', TOKEN);
}

/** 清空 HA 环境（未配置分支）。 */
function stubUnconfigured(): void {
  vi.stubEnv('HA_BASE_URL', '');
  vi.stubEnv('HA_TOKEN', '');
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await app.close();
});

describe('未配置 HA', () => {
  beforeEach(() => {
    stubUnconfigured();
  });

  it('GET /api/ha/status → 200 { configured:false, enabled:false }', async () => {
    app = buildApp({ db, haClient: makeMockHaClient() });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, enabled: false });
  });

  it('GET /api/ha/states → 503 HA_NOT_CONFIGURED', async () => {
    app = buildApp({ db, haClient: makeMockHaClient() });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/states' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('HA_NOT_CONFIGURED');
  });

  it('POST /api/ha/service → 503 HA_NOT_CONFIGURED', async () => {
    app = buildApp({ db, haClient: makeMockHaClient() });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/service',
      payload: { domain: 'light', service: 'turn_on', entity_id: 'light.a' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('HA_NOT_CONFIGURED');
  });

  it('POST /api/ha/expose-expiring → 503 HA_NOT_CONFIGURED', async () => {
    app = buildApp({ db, haClient: makeMockHaClient() });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/expose-expiring',
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('HA_NOT_CONFIGURED');
  });
});

describe('已配置 HA', () => {
  beforeEach(() => {
    stubConfigured();
  });

  it('GET /api/ha/status reachable=true（ping 成功）', async () => {
    const client = makeMockHaClient({ ping: vi.fn().mockResolvedValue(true) });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      enabled: true,
      reachable: true,
      connected: false,
    });
  });

  it('GET /api/ha/status reachable=false（ping 抛 connection HaError）', async () => {
    const client = makeMockHaClient({
      ping: vi.fn().mockRejectedValue(new HaError('无法连接 Home Assistant', 'connection')),
    });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reachable).toBe(false);
  });

  it('GET /api/ha/status connected 读取注入的 subscriber', async () => {
    const client = makeMockHaClient({ ping: vi.fn().mockResolvedValue(true) });
    const subscriber = { start: vi.fn(), stop: vi.fn(), isConnected: vi.fn(() => true) };
    app = buildApp({ db, haClient: client, haSubscriber: subscriber });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/status' });
    expect(res.json().connected).toBe(true);
  });

  it('GET /api/ha/states 返回 mock 数组', async () => {
    const states = [
      { entity_id: 'light.a', state: 'on', attributes: {} },
      { entity_id: 'switch.b', state: 'off', attributes: {} },
    ];
    const client = makeMockHaClient({ getStates: vi.fn().mockResolvedValue(states) });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/states' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(states);
  });

  it('GET /api/ha/states 连接类 HaError → 503 HA_CONNECTION', async () => {
    const client = makeMockHaClient({
      getStates: vi.fn().mockRejectedValue(new HaError('无法连接 Home Assistant', 'connection')),
    });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ha/states' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('HA_CONNECTION');
  });

  it('POST /api/ha/service 合法 body → 调 callService 并返回其结果', async () => {
    const callService = vi.fn().mockResolvedValue({ ok: true });
    const client = makeMockHaClient({ callService });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/service',
      payload: { domain: 'light', service: 'turn_on', entity_id: 'light.kitchen' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(callService).toHaveBeenCalledWith('light', 'turn_on', {
      entity_id: 'light.kitchen',
    });
  });

  it('POST /api/ha/service 缺字段 → 400 VALIDATION_ERROR', async () => {
    const client = makeMockHaClient();
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/service',
      payload: { domain: 'light' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/ha/service auth 错误 → 502 HA_AUTH', async () => {
    const client = makeMockHaClient({
      callService: vi.fn().mockRejectedValue(new HaError('未授权', 'auth')),
    });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/service',
      payload: { domain: 'light', service: 'turn_on', entity_id: 'light.a' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('HA_AUTH');
  });

  it('POST /api/ha/service not_found → 404 HA_NOT_FOUND', async () => {
    const client = makeMockHaClient({
      callService: vi.fn().mockRejectedValue(new HaError('资源不存在', 'not_found')),
    });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/service',
      payload: { domain: 'light', service: 'turn_on', entity_id: 'light.a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('HA_NOT_FOUND');
  });

  it('POST /api/ha/expose-expiring 复用 listExpiringItems + mock setState', async () => {
    const now = Date.now();
    createItem(db, { name: '酸奶', expiryDate: now + 1 * MS_PER_DAY });
    createItem(db, { name: '苹果', expiryDate: now + 100 * MS_PER_DAY });

    const setState = vi.fn().mockResolvedValue({});
    const client = makeMockHaClient({ setState });
    app = buildApp({ db, haClient: client });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ha/expose-expiring',
      payload: { days: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entityId).toBe(EXPIRING_SENSOR_ENTITY);
    expect(body.count).toBe(1);
    expect(body.itemNames).toEqual(['酸奶']);
    expect(setState).toHaveBeenCalledTimes(1);
  });
});

describe('令牌安全', () => {
  beforeEach(() => {
    stubConfigured();
  });

  it('任何响应体/错误体都不含令牌字符串', async () => {
    const client = makeMockHaClient({
      ping: vi.fn().mockResolvedValue(true),
      getStates: vi.fn().mockRejectedValue(new HaError('未授权', 'auth')),
      callService: vi.fn().mockResolvedValue({ ok: true }),
    });
    app = buildApp({ db, haClient: client });
    await app.ready();

    const paths: Array<Promise<{ body: string }>> = [
      app.inject({ method: 'GET', url: '/api/ha/status' }),
      app.inject({ method: 'GET', url: '/api/ha/states' }),
      app.inject({
        method: 'POST',
        url: '/api/ha/service',
        payload: { domain: 'light', service: 'turn_on', entity_id: 'light.a' },
      }),
    ];
    const results = await Promise.all(paths);
    for (const r of results) {
      expect(r.body).not.toContain(TOKEN);
    }
  });
});
