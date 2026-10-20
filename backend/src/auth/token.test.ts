/** 无状态 token 签发/校验单元测试 */

import { describe, expect, it } from 'vitest';

import type { AuthConfig } from './config.js';
import { issueToken, signToken, verifyToken } from './token.js';

const PASSWORD = 'secret';

describe('signToken / verifyToken 往返', () => {
  it('签发后校验通过且 payload 一致', () => {
    const payload = { iat: 1000, exp: 2000 };
    const token = signToken(PASSWORD, payload);
    const result = verifyToken(PASSWORD, token, 1500);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload).toEqual(payload);
    }
  });
});

describe('verifyToken 失败路径', () => {
  it('篡改签名最后一字符 → bad_signature', () => {
    const token = signToken(PASSWORD, { iat: 1000, exp: 2000 });
    const last = token.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = token.slice(0, -1) + last;
    const result = verifyToken(PASSWORD, tampered, 1500);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }
  });

  it('篡改 payload 段 → bad_signature 或 malformed', () => {
    const token = signToken(PASSWORD, { iat: 1000, exp: 2000 });
    const parts = token.split('.');
    const tampered = `${parts[0]}x.${parts[1]}`;
    const result = verifyToken(PASSWORD, tampered, 1500);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(['bad_signature', 'malformed']).toContain(result.reason);
    }
  });

  it('now 超过 exp → expired', () => {
    const token = signToken(PASSWORD, { iat: 1000, exp: 2000 });
    const result = verifyToken(PASSWORD, token, 2001);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it("缺段（'abc' 无点）→ malformed", () => {
    const result = verifyToken(PASSWORD, 'abc', 1500);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('用不同密码签发/校验 → bad_signature', () => {
    const token = signToken('other-password', { iat: 1000, exp: 2000 });
    const result = verifyToken(PASSWORD, token, 1500);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('bad_signature');
    }
  });
});

describe('issueToken', () => {
  const config: AuthConfig = { password: PASSWORD, enabled: true, tokenTtlMs: 60000 };

  it('在有效期内 valid', () => {
    const now = 1_000_000;
    const token = issueToken(config, now);
    const result = verifyToken(config.password, token, now + 100);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.iat).toBe(now);
      expect(result.payload.exp).toBe(now + config.tokenTtlMs);
    }
  });

  it('在 now+ttl+1 时 expired', () => {
    const now = 1_000_000;
    const token = issueToken(config, now);
    const result = verifyToken(config.password, token, now + config.tokenTtlMs + 1);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });
});
