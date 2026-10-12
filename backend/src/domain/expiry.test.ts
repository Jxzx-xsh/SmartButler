/** 到期计算纯函数单元测试 */

import { describe, expect, it } from 'vitest';

import {
  computeExpiryDate,
  daysUntilExpiry,
  isExpiringWithin,
  MS_PER_DAY,
} from './expiry.js';

// 固定基准时间，避免时钟抖动：2024-01-01T00:00:00.000Z
const NOW = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

describe('computeExpiryDate', () => {
  it('两者齐全时返回 purchaseDate + shelfLifeDays 天', () => {
    expect(computeExpiryDate(NOW, 7)).toBe(NOW + 7 * MS_PER_DAY);
  });

  it('缺少 shelfLifeDays 返回 null', () => {
    expect(computeExpiryDate(NOW, null)).toBeNull();
  });

  it('缺少 purchaseDate 返回 null', () => {
    expect(computeExpiryDate(null, 7)).toBeNull();
  });

  it('两者皆缺返回 null', () => {
    expect(computeExpiryDate(null, null)).toBeNull();
  });
});

describe('daysUntilExpiry', () => {
  it('未来到期返回正数天数', () => {
    const item = { expiryDate: NOW + 3 * MS_PER_DAY };
    expect(daysUntilExpiry(item, NOW)).toBe(3);
  });

  it('今天到期返回 0', () => {
    const item = { expiryDate: NOW };
    expect(daysUntilExpiry(item, NOW)).toBe(0);
  });

  it('已过期返回负数', () => {
    const item = { expiryDate: NOW - 2 * MS_PER_DAY };
    expect(daysUntilExpiry(item, NOW)).toBe(-2);
  });

  it('无到期日返回 null', () => {
    expect(daysUntilExpiry({ expiryDate: null }, NOW)).toBeNull();
  });
});

describe('isExpiringWithin', () => {
  it('恰好第 N 天视为在范围内', () => {
    const item = { expiryDate: NOW + 3 * MS_PER_DAY };
    expect(isExpiringWithin(item, 3, NOW)).toBe(true);
  });

  it('超出范围返回 false', () => {
    const item = { expiryDate: NOW + 5 * MS_PER_DAY };
    expect(isExpiringWithin(item, 3, NOW)).toBe(false);
  });

  it('已过期视为在范围内', () => {
    const item = { expiryDate: NOW - 1 * MS_PER_DAY };
    expect(isExpiringWithin(item, 3, NOW)).toBe(true);
  });

  it('无到期日返回 false', () => {
    expect(isExpiringWithin({ expiryDate: null }, 3, NOW)).toBe(false);
  });
});
