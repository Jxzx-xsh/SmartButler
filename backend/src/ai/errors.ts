/**
 * AI 调用错误分类。
 *
 * 把底层 SDK/网络抛出的各类错误统一包装为 LmStudioError，并附带 kind，
 * 供上层调度器据此判断是否可重试（connection/timeout 可重试，其余不可），
 * 以及决定如何降级。
 */

/** 错误类别：连接失败 / 超时 / 响应结构异常 / 其他未知。 */
export type LmStudioErrorKind = 'connection' | 'timeout' | 'bad_response' | 'unknown';

/** LM Studio 调用统一错误类型。 */
export class LmStudioError extends Error {
  /** 错误类别，用于重试判定与降级决策 */
  readonly kind: LmStudioErrorKind;
  /** 原始错误（保留以便排查） */
  override readonly cause?: unknown;

  constructor(message: string, kind: LmStudioErrorKind, cause?: unknown) {
    super(message);
    this.name = 'LmStudioError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * 判断错误是否可重试。
 * 仅 LmStudioError 且 kind 为 connection/timeout 时返回 true，其余一律 false。
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof LmStudioError && (err.kind === 'connection' || err.kind === 'timeout');
}
