/** 门控配置读取单元测试：注入 env 对象，不依赖真实 process.env。 */

import { describe, expect, it } from 'vitest';

import { loadGatingConfig } from './config.js';

describe('loadGatingConfig', () => {
  it('env 为空时返回全部缺省值', () => {
    const cfg = loadGatingConfig({});
    expect(cfg).toEqual({
      motionThreshold: 0.08,
      motionThumbWidth: 64,
      motionThumbHeight: 48,
      motionPerPixelDelta: 24,
      motionCooldownMs: 1500,
      motionMinConsecutiveFrames: 1,
      vadEnergyThreshold: 500,
      vadFrameMs: 20,
      vadTriggerMs: 150,
      vadHangoverMs: 600,
      vadMinEventMs: 300,
      vadCooldownMs: 500,
    });
  });

  it('每个环境变量都能覆盖对应字段', () => {
    const cfg = loadGatingConfig({
      MOTION_THRESHOLD: '0.2',
      MOTION_THUMB_WIDTH: '80',
      MOTION_THUMB_HEIGHT: '60',
      MOTION_PER_PIXEL_DELTA: '30',
      MOTION_COOLDOWN_MS: '2000',
      MOTION_MIN_CONSECUTIVE_FRAMES: '3',
      VAD_ENERGY_THRESHOLD: '800',
      VAD_FRAME_MS: '30',
      VAD_TRIGGER_MS: '200',
      VAD_HANGOVER_MS: '700',
      VAD_MIN_EVENT_MS: '400',
      VAD_COOLDOWN_MS: '600',
    });
    expect(cfg).toEqual({
      motionThreshold: 0.2,
      motionThumbWidth: 80,
      motionThumbHeight: 60,
      motionPerPixelDelta: 30,
      motionCooldownMs: 2000,
      motionMinConsecutiveFrames: 3,
      vadEnergyThreshold: 800,
      vadFrameMs: 30,
      vadTriggerMs: 200,
      vadHangoverMs: 700,
      vadMinEventMs: 400,
      vadCooldownMs: 600,
    });
  });

  it('MOTION_THRESHOLD 超范围（>1）回退默认 0.08', () => {
    expect(loadGatingConfig({ MOTION_THRESHOLD: '1.5' }).motionThreshold).toBe(0.08);
  });

  it('MOTION_THRESHOLD 负数回退默认 0.08', () => {
    expect(loadGatingConfig({ MOTION_THRESHOLD: '-0.3' }).motionThreshold).toBe(0.08);
  });

  it('MOTION_THRESHOLD 非数字回退默认 0.08', () => {
    expect(loadGatingConfig({ MOTION_THRESHOLD: 'abc' }).motionThreshold).toBe(0.08);
  });

  it('MOTION_PER_PIXEL_DELTA 超范围（>255）回退默认 24', () => {
    expect(loadGatingConfig({ MOTION_PER_PIXEL_DELTA: '300' }).motionPerPixelDelta).toBe(24);
  });

  it('MOTION_MIN_CONSECUTIVE_FRAMES <1 回退默认 1', () => {
    expect(loadGatingConfig({ MOTION_MIN_CONSECUTIVE_FRAMES: '0' }).motionMinConsecutiveFrames).toBe(1);
  });

  it('MOTION_COOLDOWN_MS=0 合法（允许无冷却）', () => {
    expect(loadGatingConfig({ MOTION_COOLDOWN_MS: '0' }).motionCooldownMs).toBe(0);
  });

  it('VAD_FRAME_MS=100 夹到上限 30', () => {
    expect(loadGatingConfig({ VAD_FRAME_MS: '100' }).vadFrameMs).toBe(30);
  });

  it('VAD_FRAME_MS=5 夹到下限 20', () => {
    expect(loadGatingConfig({ VAD_FRAME_MS: '5' }).vadFrameMs).toBe(20);
  });

  it('VAD_FRAME_MS 非数字回退默认 20', () => {
    expect(loadGatingConfig({ VAD_FRAME_MS: 'xyz' }).vadFrameMs).toBe(20);
  });

  it('VAD_ENERGY_THRESHOLD 超范围（>32767）回退默认 500', () => {
    expect(loadGatingConfig({ VAD_ENERGY_THRESHOLD: '40000' }).vadEnergyThreshold).toBe(500);
  });

  it('VAD_ENERGY_THRESHOLD 负数回退默认 500', () => {
    expect(loadGatingConfig({ VAD_ENERGY_THRESHOLD: '-10' }).vadEnergyThreshold).toBe(500);
  });
});
