/** 日期归一化辅助函数单元测试 */

import { describe, expect, it } from 'vitest';

import { normalizeToMillis } from './date-normalize.js';

describe('normalizeToMillis', () => {
  it('毫秒 number 直接返回', () => {
    expect(normalizeToMillis(1704067200000)).toBe(1704067200000);
  });

  it('纯数字字符串按毫秒整数解析', () => {
    expect(normalizeToMillis('1704067200000')).toBe(1704067200000);
  });

  it('ISO 8601 字符串转为毫秒', () => {
    const iso = '2024-01-01T00:00:00.000Z';
    expect(normalizeToMillis(iso)).toBe(Date.UTC(2024, 0, 1, 0, 0, 0, 0));
  });

  it('仅日期的 ISO 字符串也可解析', () => {
    expect(normalizeToMillis('2024-01-01')).toBe(Date.parse('2024-01-01'));
  });

  it('非法字符串抛错', () => {
    expect(() => normalizeToMillis('not-a-date')).toThrow();
  });

  it('空字符串抛错', () => {
    expect(() => normalizeToMillis('   ')).toThrow();
  });

  it('NaN 抛错', () => {
    expect(() => normalizeToMillis(Number.NaN)).toThrow();
  });

  it('Infinity 抛错', () => {
    expect(() => normalizeToMillis(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('非整数 number 抛错', () => {
    expect(() => normalizeToMillis(1.5)).toThrow();
  });
});
