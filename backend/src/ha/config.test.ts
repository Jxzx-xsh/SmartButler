/** HA 配置读取单元测试（纯函数，注入 env 对象） */

import { describe, expect, it } from 'vitest';

import { isHaConfigured, loadHaConfig } from './config.js';

describe('loadHaConfig 默认值', () => {
  it('空 env：baseUrl/token/wsUrl 为空，默认值与 isHaConfigured false', () => {
    const config = loadHaConfig({});
    expect(config.baseUrl).toBe('');
    expect(config.token).toBe('');
    expect(config.wsUrl).toBe('');
    expect(config.timeoutMs).toBe(10000);
    expect(config.reconnectBaseMs).toBe(1000);
    expect(config.reconnectMaxMs).toBe(30000);
    expect(config.stateChangedEventType).toBe('state_changed');
    expect(isHaConfigured(config)).toBe(false);
  });
});

describe('loadHaConfig wsUrl 推导', () => {
  it('HA_BASE_URL=http://ha:8123 推导 ws://ha:8123/api/websocket', () => {
    const config = loadHaConfig({ HA_BASE_URL: 'http://ha:8123' });
    expect(config.wsUrl).toBe('ws://ha:8123/api/websocket');
  });

  it('https 推导 wss', () => {
    const config = loadHaConfig({ HA_BASE_URL: 'https://ha.example.com' });
    expect(config.wsUrl).toBe('wss://ha.example.com/api/websocket');
  });

  it('HA_WS_URL 显式覆盖推导结果', () => {
    const config = loadHaConfig({
      HA_BASE_URL: 'http://ha:8123',
      HA_WS_URL: 'ws://custom:9000/ws',
    });
    expect(config.wsUrl).toBe('ws://custom:9000/ws');
  });

  it('baseUrl 末尾斜杠被去除，推导不含重复斜杠', () => {
    const config = loadHaConfig({ HA_BASE_URL: 'http://ha:8123/' });
    expect(config.baseUrl).toBe('http://ha:8123');
    expect(config.wsUrl).toBe('ws://ha:8123/api/websocket');
  });
});

describe('loadHaConfig 超时解析与配置判定', () => {
  it('HA_TIMEOUT_MS 非法时回退默认 10000', () => {
    expect(loadHaConfig({ HA_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(10000);
    expect(loadHaConfig({ HA_TIMEOUT_MS: '0' }).timeoutMs).toBe(10000);
    expect(loadHaConfig({ HA_TIMEOUT_MS: '-5' }).timeoutMs).toBe(10000);
  });

  it('HA_TIMEOUT_MS 合法时生效', () => {
    expect(loadHaConfig({ HA_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
  });

  it('baseUrl 与 token 均非空 → isHaConfigured true', () => {
    const config = loadHaConfig({ HA_BASE_URL: 'http://ha:8123', HA_TOKEN: 'secret' });
    expect(isHaConfigured(config)).toBe(true);
  });

  it('仅有其一时 isHaConfigured false', () => {
    expect(isHaConfigured(loadHaConfig({ HA_BASE_URL: 'http://ha:8123' }))).toBe(false);
    expect(isHaConfigured(loadHaConfig({ HA_TOKEN: 'secret' }))).toBe(false);
  });
});
