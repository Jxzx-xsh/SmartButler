/** 提醒配置读取单元测试（纯函数，注入 env 对象） */

import { describe, expect, it } from 'vitest';

import { loadReminderConfig } from './config.js';

describe('loadReminderConfig 默认值', () => {
  it('空 env：intervalMs 3600000、expiryDays 3', () => {
    const config = loadReminderConfig({});
    expect(config.intervalMs).toBe(3_600_000);
    expect(config.expiryDays).toBe(3);
  });
});

describe('loadReminderConfig 合法覆盖', () => {
  it('合法 REMINDER_INTERVAL_MS / REMINDER_EXPIRY_DAYS 生效', () => {
    const config = loadReminderConfig({
      REMINDER_INTERVAL_MS: '60000',
      REMINDER_EXPIRY_DAYS: '7',
    });
    expect(config.intervalMs).toBe(60_000);
    expect(config.expiryDays).toBe(7);
  });
});

describe('loadReminderConfig 非法回退', () => {
  it('REMINDER_INTERVAL_MS 非法（NaN/<=0）回退默认 3600000', () => {
    expect(loadReminderConfig({ REMINDER_INTERVAL_MS: 'abc' }).intervalMs).toBe(3_600_000);
    expect(loadReminderConfig({ REMINDER_INTERVAL_MS: '0' }).intervalMs).toBe(3_600_000);
    expect(loadReminderConfig({ REMINDER_INTERVAL_MS: '-5' }).intervalMs).toBe(3_600_000);
  });

  it('REMINDER_EXPIRY_DAYS 非法（NaN/<=0）回退默认 3', () => {
    expect(loadReminderConfig({ REMINDER_EXPIRY_DAYS: 'xyz' }).expiryDays).toBe(3);
    expect(loadReminderConfig({ REMINDER_EXPIRY_DAYS: '0' }).expiryDays).toBe(3);
    expect(loadReminderConfig({ REMINDER_EXPIRY_DAYS: '-1' }).expiryDays).toBe(3);
  });
});
