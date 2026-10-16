/** HA REST 客户端单元测试（注入 mock fetch，不触真实网络） */

import { describe, expect, it, vi } from 'vitest';

import { createHaClient } from './ha-client.js';
import { HaConfig, loadHaConfig } from './config.js';
import { HaError } from './errors.js';

/** 构造测试用配置（baseUrl + token 固定） */
function testConfig(overrides: Partial<HaConfig> = {}): HaConfig {
  return {
    ...loadHaConfig({ HA_BASE_URL: 'http://ha:8123', HA_TOKEN: 'secret-token' }),
    ...overrides,
  };
}

/** 构造一个 Response-like 的 mock 返回体 */
function mockResponse(opts: {
  status?: number;
  jsonValue?: unknown;
  jsonThrows?: boolean;
}): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (opts.jsonThrows) {
        throw new Error('非 JSON 内容');
      }
      return opts.jsonValue;
    },
    async text() {
      return typeof opts.jsonValue === 'string' ? opts.jsonValue : JSON.stringify(opts.jsonValue);
    },
  } as unknown as Response;
}

describe('ping', () => {
  it('message 为 API running. 时返回 true，url 结尾 /api/ 且带 Bearer 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: { message: 'API running.' } }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    const ok = await client.ping();
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith('/api/')).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  it('message 非预期值时返回 false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: { message: 'nope' } }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    expect(await client.ping()).toBe(false);
  });
});

describe('令牌安全', () => {
  it('令牌只出现在 Authorization 头，不在返回值、不在抛出的 HaError.message 中', async () => {
    // 返回体中混入一个无关字段，确认返回值不含令牌
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ jsonValue: { message: 'API running.', extra: 'x' } }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    const result = await client.ping();
    expect(JSON.stringify(result)).not.toContain('secret-token');

    // 令牌仅在 Authorization 头出现
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toContain('secret-token');

    // 触发一个 401 错误，断言错误消息不含令牌
    const authFetch = vi.fn().mockResolvedValue(mockResponse({ status: 401 }));
    const authClient = createHaClient({ config: testConfig(), fetch: authFetch as unknown as typeof fetch });
    try {
      await authClient.getStates();
      expect.unreachable('应抛出 HaError');
    } catch (err) {
      expect(err).toBeInstanceOf(HaError);
      expect((err as HaError).message).not.toContain('secret-token');
    }
  });
});

describe('getStates', () => {
  it('返回数组 → HaEntityState[]', async () => {
    const states = [{ entity_id: 'light.a', state: 'on', attributes: {} }];
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: states }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    const result = await client.getStates();
    expect(result).toEqual(states);
  });

  it('非数组 → bad_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: { not: 'array' } }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    await expect(client.getStates()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('getState 错误分类', () => {
  it('404 → not_found', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 404 }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    await expect(client.getState('light.missing')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('callService / turnOn / turnOff / setState', () => {
  it('callService 组装 POST /api/services/<domain>/<service> 与 body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: {} }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    await client.callService('light', 'turn_on', { entity_id: 'light.a' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ha:8123/api/services/light/turn_on');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ entity_id: 'light.a' });
  });

  it('turnOn/turnOff 走通用 homeassistant 域 + {entity_id}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: {} }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    await client.turnOn('switch.b');
    await client.turnOff('switch.b');

    const [urlOn, initOn] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(urlOn).toBe('http://ha:8123/api/services/homeassistant/turn_on');
    expect(JSON.parse(initOn.body as string)).toEqual({ entity_id: 'switch.b' });

    const [urlOff, initOff] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(urlOff).toBe('http://ha:8123/api/services/homeassistant/turn_off');
    expect(JSON.parse(initOff.body as string)).toEqual({ entity_id: 'switch.b' });
  });

  it('setState 组装 POST /api/states/<id> 与 body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonValue: {} }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });

    await client.setState('sensor.x', { state: '3', attributes: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ha:8123/api/states/sensor.x');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ state: '3', attributes: { a: 1 } });
  });
});

describe('错误分类', () => {
  it('401 → auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 401 }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getStates()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('404 → not_found', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 404 }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getStates()).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('500 → bad_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ status: 500 }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getStates()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('fetch 抛 {code:ECONNREFUSED} → connection', async () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    const fetchMock = vi.fn().mockRejectedValue(err);
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.ping()).rejects.toMatchObject({ kind: 'connection' });
  });

  it('AbortError → connection', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchMock = vi.fn().mockRejectedValue(abort);
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.ping()).rejects.toMatchObject({ kind: 'connection' });
  });

  it('res.json() 抛 → bad_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ jsonThrows: true }));
    const client = createHaClient({ config: testConfig(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.getStates()).rejects.toMatchObject({ kind: 'bad_response' });
  });
});
