/**
 * Home Assistant 集成错误分类。
 *
 * 把底层 fetch/网络/HA 响应抛出的各类错误统一包装为 HaError，并附带 kind，
 * 供上层据此判断如何处理（connection 可重试/降级，auth/config 属配置问题，
 * not_found/bad_response 属具体请求问题）。各 kind 语义：
 * - connection：无法连接 HA（拒连/域名解析失败/超时/网络中断），通常可重试。
 * - auth：鉴权失败（长期访问令牌缺失或无效，HTTP 401），需检查令牌配置。
 * - not_found：目标实体/资源不存在（HTTP 404）。
 * - bad_response：HA 返回了非预期结构或非 2xx 非上述状态（含 JSON 解析失败）。
 * - config：本地配置缺失或非法（如未配置 baseUrl/token），调用方自检用。
 *
 * 注意：错误消息中绝不含令牌或任何敏感凭据。
 */

/** 错误类别：连接失败 / 鉴权失败 / 资源不存在 / 响应异常 / 配置问题。 */
export type HaErrorKind = 'connection' | 'auth' | 'not_found' | 'bad_response' | 'config';

/** Home Assistant 调用统一错误类型。 */
export class HaError extends Error {
  /** 错误类别，用于重试判定与配置自检 */
  readonly kind: HaErrorKind;
  /** 原始错误（保留以便排查，不对外回显） */
  override readonly cause?: unknown;

  constructor(message: string, kind: HaErrorKind, cause?: unknown) {
    super(message);
    this.name = 'HaError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * 判断错误是否可重试。
 * 仅 HaError 且 kind 为 connection 时返回 true，其余一律 false。
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof HaError && err.kind === 'connection';
}
