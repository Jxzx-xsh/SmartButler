/**
 * 无状态访问 token 的签发与校验。
 *
 * 采用 HMAC-SHA256 对 payload 做签名，token 形如 `${payloadB64}.${sigB64}`
 * （均为 base64url 编码），服务端无需存储会话——校验时用访问密码重算签名比对，
 * 并检查 payload 内的过期时间 exp。不引入 jsonwebtoken 等第三方。
 *
 * 安全约束：签名密钥即访问密码（敏感），仅在内存中参与运算，
 * 绝不写入 token、日志或任何响应体；签名比对用 crypto.timingSafeEqual 防时序攻击。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthConfig } from './config.js';

/** token 载荷：签发时间与过期时间（均为毫秒时间戳）。 */
export interface TokenPayload {
  /** 签发时间（毫秒） */
  iat: number;
  /** 过期时间（毫秒） */
  exp: number;
}

/** 校验结果：成功带解析出的 payload，失败带不通过原因。 */
export type VerifyResult =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

/** 用访问密码对 payloadB64 计算 HMAC-SHA256 签名，返回 base64url 字符串。 */
function computeSignature(password: string, payloadB64: string): string {
  return createHmac('sha256', password).update(payloadB64).digest('base64url');
}

/**
 * 用访问密码对 payload 签名，返回 `${payloadB64}.${sigB64}`。
 * payload 先 JSON 序列化再 base64url 编码，签名对 payloadB64 计算。
 */
export function signToken(password: string, payload: TokenPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigB64 = computeSignature(password, payloadB64);
  return `${payloadB64}.${sigB64}`;
}

/**
 * 校验 token：按 '.' 拆两段，重算签名并用 timingSafeEqual 比对，再检查过期。
 * @param now 当前时间（毫秒），默认 Date.now()，便于测试注入。
 */
export function verifyToken(
  password: string,
  token: string,
  now: number = Date.now(),
): VerifyResult {
  // 段数必须恰为 2（payloadB64.sigB64）
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'malformed' };
  }
  const [payloadB64, sigB64] = parts as [string, string];

  // 重算签名并比对：先 base64url 解码两侧签名为 Buffer，长度不等直接判签名错，
  // 不调 timingSafeEqual（长度不等会抛错）。
  const expectedSig = computeSignature(password, payloadB64);
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  const actualBuf = Buffer.from(sigB64, 'base64url');
  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!timingSafeEqual(expectedBuf, actualBuf)) {
    return { valid: false, reason: 'bad_signature' };
  }

  // 解析 payload JSON：解码/解析失败或缺少合法 exp 视为 malformed
  let payload: TokenPayload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { exp?: unknown }).exp !== 'number'
    ) {
      return { valid: false, reason: 'malformed' };
    }
    payload = parsed as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // 过期检查
  if (now > payload.exp) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}

/**
 * 基于配置签发新 token：iat=now，exp=now+tokenTtlMs。
 * @param now 当前时间（毫秒），默认 Date.now()，便于测试注入。
 */
export function issueToken(config: AuthConfig, now: number = Date.now()): string {
  const payload: TokenPayload = { iat: now, exp: now + config.tokenTtlMs };
  return signToken(config.password, payload);
}
