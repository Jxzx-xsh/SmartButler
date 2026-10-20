/** 访问鉴权配置读取单元测试（纯函数，注入 env 对象） */

import { describe, expect, it } from 'vitest';

import { isAuthEnabled, loadAuthConfig } from './config.js';

describe('loadAuthConfig 默认值', () => {
  it('空 env：password 空、enabled true、ttl 30 天，isAuthEnabled false', () => {
    const config = loadAuthConfig({});
    expect(config.password).toBe('');
    expect(config.enabled).toBe(true);
    expect(config.tokenTtlMs).toBe(30 * 24 * 3600 * 1000);
    expect(isAuthEnabled(config)).toBe(false);
  });
});

describe('loadAuthConfig enabled 开关', () => {
  it("SMARTBUTLER_AUTH_ENABLED='false' 使 enabled=false", () => {
    const config = loadAuthConfig({ SMARTBUTLER_AUTH_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it("非 'false' 值（含 'true'、'0'、任意字符串）保持 enabled=true", () => {
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_ENABLED: 'true' }).enabled).toBe(true);
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_ENABLED: '0' }).enabled).toBe(true);
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_ENABLED: 'yes' }).enabled).toBe(true);
  });
});

describe('loadAuthConfig tokenTtlMs 解析', () => {
  it('合法正数生效', () => {
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_TOKEN_TTL_MS: '60000' }).tokenTtlMs).toBe(
      60000,
    );
  });

  it("非法（'abc'、'0'、'-5'）回退默认 30 天", () => {
    const def = 30 * 24 * 3600 * 1000;
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_TOKEN_TTL_MS: 'abc' }).tokenTtlMs).toBe(def);
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_TOKEN_TTL_MS: '0' }).tokenTtlMs).toBe(def);
    expect(loadAuthConfig({ SMARTBUTLER_AUTH_TOKEN_TTL_MS: '-5' }).tokenTtlMs).toBe(def);
  });
});

describe('isAuthEnabled 真值表', () => {
  it('enabled 且密码非空 → true', () => {
    expect(isAuthEnabled({ password: 'secret', enabled: true, tokenTtlMs: 1 })).toBe(true);
  });

  it('密码为空时恒 false（即便 enabled=true）', () => {
    expect(isAuthEnabled({ password: '', enabled: true, tokenTtlMs: 1 })).toBe(false);
  });

  it('enabled=false 时恒 false（即便密码非空）', () => {
    expect(isAuthEnabled({ password: 'secret', enabled: false, tokenTtlMs: 1 })).toBe(
      false,
    );
  });
});
