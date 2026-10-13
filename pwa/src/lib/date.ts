/** 日期工具：毫秒整数 <-> 显示 / <input type="date"> 值。均按本地时区处理。 */

/** 补零到两位。 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 毫秒 -> 中文可读 YYYY/MM/DD；null 返回占位符。 */
export function formatDate(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 毫秒 -> <input type="date"> 需要的 YYYY-MM-DD（本地时区）；null 返回空串。 */
export function dateInputValue(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** <input type="date"> 的 YYYY-MM-DD -> 本地当天零点的毫秒整数；空串返回 null。 */
export function dateStrToMillis(str: string): number | null {
  if (!str) return null;
  const ms = new Date(`${str}T00:00:00`).getTime();
  return Number.isNaN(ms) ? null : ms;
}
