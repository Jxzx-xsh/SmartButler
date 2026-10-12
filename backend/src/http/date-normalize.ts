/**
 * 日期归一化辅助：把外部传入的「ISO 8601 字符串」或「毫秒时间戳」
 * 统一归一化为 **Unix 毫秒整数**（与全库日期存储一致，见 schema.ts）。
 *
 * 纯函数，无副作用、不依赖数据库，便于单测。非法输入抛 Error，
 * 由校验层（zod transform）捕获转为 400。
 */

import { z } from 'zod';

/**
 * 把字符串或数字归一化为毫秒整数时间戳。
 *
 * 规则：
 * - number：必须是有限整数毫秒，直接返回；拒绝 NaN / Infinity / 非整数。
 * - 纯数字字符串（如 "1704067200000"）：按毫秒整数解析。
 * - 其他字符串：按 ISO 8601 用 Date.parse 解析；解析失败（NaN）抛错。
 *
 * @throws Error 当输入无法归一化为合法毫秒整数时
 */
export function normalizeToMillis(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || !Number.isInteger(input)) {
      throw new Error(`非法的毫秒时间戳：${input}`);
    }
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    throw new Error('日期字符串为空');
  }

  // 纯数字字符串按毫秒整数解析
  if (/^-?\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
      throw new Error(`非法的毫秒时间戳字符串：${input}`);
    }
    return ms;
  }

  // 其他按 ISO 8601 解析
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析的日期字符串：${input}`);
  }
  return parsed;
}

/**
 * 可复用的 zod 日期片段：接受 number 或 string，归一化为毫秒整数。
 * 归一化失败时通过 ctx.addIssue 报错并返回 z.NEVER，交给统一错误处理转 400。
 */
export const zMillisDate = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    try {
      return normalizeToMillis(value);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : '非法日期',
      });
      return z.NEVER;
    }
  });
