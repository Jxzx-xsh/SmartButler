/** 当前日期上下文单元测试（纯函数，注入固定 nowMs，确定性、不触网） */

import { describe, expect, it } from 'vitest';

import { buildDateContext, WEEKDAY_ZH } from './date-context.js';

describe('buildDateContext', () => {
  it('固定时刻返回 Asia/Shanghai 的 YYYY-MM-DD 与中文星期', () => {
    // 2025-01-01T12:00:00+08:00 为周三
    const ctx = buildDateContext(Date.parse('2025-01-01T12:00:00+08:00'));
    expect(ctx.date).toBe('2025-01-01');
    expect(ctx.weekday).toBe('周三');
  });

  it('跨 Asia/Shanghai 日界：UTC 仍是前一天的时刻按东八区归入次日', () => {
    // 2025-01-01T20:00:00Z = 2025-01-02T04:00:00+08:00（东八区已跨到次日，周四）
    const ctx = buildDateContext(Date.parse('2025-01-01T20:00:00Z'));
    expect(ctx.date).toBe('2025-01-02');
    expect(ctx.weekday).toBe('周四');
  });

  it('周六用例：2025-01-04 对应周六', () => {
    const ctx = buildDateContext(Date.parse('2025-01-04T12:00:00+08:00'));
    expect(ctx.date).toBe('2025-01-04');
    expect(ctx.weekday).toBe('周六');
  });

  it('WEEKDAY_ZH 常量覆盖周日到周六', () => {
    expect(WEEKDAY_ZH).toEqual(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
  });
});
