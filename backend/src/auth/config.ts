/**
 * 访问鉴权配置集中读取。
 *
 * 所有鉴权参数都通过环境变量注入，缺省时回退到安全的本地默认值；
 * 这样部署方可按需用环境变量覆盖，而测试/开发无需额外配置即可运行。
 * 解析范式镜像 ha/config.ts 与 reminders/config.ts：用 Number 解析，
 * 非法（NaN）或 <=0 统一回退默认。
 *
 * 安全约束：password 为单一访问密码，属敏感凭据，仅由环境变量注入，
 * 绝不硬编码、绝不入库、绝不写日志、绝不回显到任何响应体或错误消息中。
 */

/** 访问鉴权配置。 */
export interface AuthConfig {
  /**
   * 单一访问密码（敏感）。
   * 同时用作登录比对与 HMAC 签名密钥；
   * 绝不硬编码/入库/写日志/回显。未配置时为空字符串。
   */
  password: string;
  /** 是否启用鉴权（仅字符串 'false' 可显式关闭），默认 true */
  enabled: boolean;
  /** 无状态 token 有效期（毫秒），默认 30 天 */
  tokenTtlMs: number;
}

/** token 有效期默认值（毫秒）：30 天。 */
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * 从环境变量读取鉴权配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // 访问密码（敏感）：缺省空字符串（空=不启用鉴权）
  const password = env.SMARTBUTLER_ACCESS_PASSWORD ?? '';

  // 是否启用：默认启用，仅当显式设为字符串 'false' 时关闭
  const enabled = (env.SMARTBUTLER_AUTH_ENABLED ?? 'true') !== 'false';

  // token 有效期：非法（NaN）或 <=0 回退默认 30 天
  const parsedTtl = Number(env.SMARTBUTLER_AUTH_TOKEN_TTL_MS);
  const tokenTtlMs =
    Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : DEFAULT_TOKEN_TTL_MS;

  return { password, enabled, tokenTtlMs };
}

/**
 * 判断访问鉴权是否实际生效：需同时满足已启用且设置了非空密码。
 * 供接线层据此决定是否放行全部请求（未配置密码时默认不拦截，便于纯本地开发）。
 */
export function isAuthEnabled(config: AuthConfig): boolean {
  return config.enabled && config.password !== '';
}
