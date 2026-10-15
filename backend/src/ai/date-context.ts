/**
 * 当前日期上下文（Asia/Shanghai 语义）。
 *
 * 从 item-parser 抽出的共享逻辑：基于可注入的 now 毫秒，用 Intl.DateTimeFormat
 * 固定时区为 Asia/Shanghai 取出今天的 YYYY-MM-DD 与中文星期，供文本/视觉解析器
 * 注入进系统提示，让模型把中文相对/模糊日期换算为绝对日期。
 *
 * 实现与原 item-parser 内私有 buildDateContext 逐字等价（行为不变），
 * 不受运行机器本地时区影响，保证注入提示与测试断言一致。
 */

/** 中文星期几（0=周日 … 6=周六）。 */
export const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * 基于 now 毫秒生成「当前日期上下文」文本（Asia/Shanghai 语义）。
 *
 * 用 Intl.DateTimeFormat 固定 timeZone 为 Asia/Shanghai 取出年/月/日与星期，
 * 不受运行机器本地时区影响，保证注入提示与测试断言一致。
 */
export function buildDateContext(nowMs: number): { date: string; weekday: string } {
  const d = new Date(nowMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const date = `${year}-${month}-${day}`;

  // 星期几：用 Asia/Shanghai 的 weekday 短名映射回 0-6，再取中文名
  const wdShort = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(d);
  const WD_MAP: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekdayIdx = WD_MAP[wdShort] ?? 0;
  const weekday = WEEKDAY_ZH[weekdayIdx] ?? '周日';

  return { date, weekday };
}
