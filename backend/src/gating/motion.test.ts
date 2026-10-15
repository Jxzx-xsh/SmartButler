/** 移动侦测单元测试：computeFrameDiff 纯函数 + createMotionDetector 行为（用 sharp 合成纯色 JPEG）。 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { computeFrameDiff, createMotionDetector } from './motion.js';

describe('computeFrameDiff', () => {
  it('两个全等像素数组 → mad 0、changedRatio 0', () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    const b = new Uint8Array([10, 20, 30, 40]);
    expect(computeFrameDiff(a, b, 24)).toEqual({ mad: 0, changedRatio: 0 });
  });

  it('一半像素差值远超 perPixelDelta → changedRatio ≈ 0.5', () => {
    // 4 像素：前两个相同，后两个差 200（>24）
    const prev = new Uint8Array([0, 0, 0, 0]);
    const curr = new Uint8Array([0, 0, 200, 200]);
    const { changedRatio, mad } = computeFrameDiff(prev, curr, 24);
    expect(changedRatio).toBe(0.5);
    // mad = (0 + 0 + 200 + 200) / 4 = 100
    expect(mad).toBe(100);
  });

  it('长度不等应抛错', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2]);
    expect(() => computeFrameDiff(a, b, 24)).toThrow();
  });

  it('空数组 → mad 0、changedRatio 0', () => {
    expect(computeFrameDiff(new Uint8Array(0), new Uint8Array(0), 24)).toEqual({
      mad: 0,
      changedRatio: 0,
    });
  });
});

/** 合成一张纯色 JPEG（width×height，RGB 背景色）。 */
async function makeSolidJpeg(
  width: number,
  height: number,
  color: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

describe('createMotionDetector', () => {
  const detectorOptions = {
    threshold: 0.5,
    thumbWidth: 16,
    thumbHeight: 16,
    perPixelDelta: 24,
    cooldownMs: 1000,
    minConsecutiveFrames: 1,
  };

  it('首帧只建基线返回 null，第二帧明显不同超阈值产出 MotionEvent 且 frame 等于传入 buffer', async () => {
    const detector = createMotionDetector(detectorOptions);
    const black = await makeSolidJpeg(32, 32, { r: 0, g: 0, b: 0 });
    const white = await makeSolidJpeg(32, 32, { r: 255, g: 255, b: 255 });

    const first = await detector.processFrame(black, 0);
    expect(first).toBeNull();

    const second = await detector.processFrame(white, 100);
    expect(second).not.toBeNull();
    expect(second?.frame).toBe(white);
    expect(second?.timestamp).toBe(100);
    expect(second?.changedRatio).toBeGreaterThanOrEqual(detectorOptions.threshold);
  });

  it('两张相同帧不产事件', async () => {
    const detector = createMotionDetector(detectorOptions);
    const grey = await makeSolidJpeg(32, 32, { r: 128, g: 128, b: 128 });

    expect(await detector.processFrame(grey, 0)).toBeNull();
    expect(await detector.processFrame(grey, 100)).toBeNull();
  });

  it('冷却时间内第二次运动被抑制，冷却结束后恢复', async () => {
    const detector = createMotionDetector({ ...detectorOptions, cooldownMs: 1000 });
    const black = await makeSolidJpeg(32, 32, { r: 0, g: 0, b: 0 });
    const white = await makeSolidJpeg(32, 32, { r: 255, g: 255, b: 255 });

    // 基线
    expect(await detector.processFrame(black, 0)).toBeNull();
    // 第一次运动（t=100）产出
    expect(await detector.processFrame(white, 100)).not.toBeNull();
    // 冷却内（t=500，距上次 400 < 1000）被抑制
    expect(await detector.processFrame(black, 500)).toBeNull();
    // 冷却结束（t=1200，距上次事件 1100 ≥ 1000）恢复
    expect(await detector.processFrame(white, 1200)).not.toBeNull();
  });

  it('minConsecutiveFrames=2 时需连续两帧命中才产事件', async () => {
    const detector = createMotionDetector({
      ...detectorOptions,
      minConsecutiveFrames: 2,
      cooldownMs: 0,
    });
    const black = await makeSolidJpeg(32, 32, { r: 0, g: 0, b: 0 });
    const white = await makeSolidJpeg(32, 32, { r: 255, g: 255, b: 255 });

    // 基线
    expect(await detector.processFrame(black, 0)).toBeNull();
    // 第一次命中（black→white），连续计数=1 < 2，不产事件
    expect(await detector.processFrame(white, 100)).toBeNull();
    // 第二次命中（white→black），连续计数=2 ≥ 2，产事件
    expect(await detector.processFrame(black, 200)).not.toBeNull();
  });

  it('reset 后基线清空，下一帧重新作为基线', async () => {
    const detector = createMotionDetector(detectorOptions);
    const black = await makeSolidJpeg(32, 32, { r: 0, g: 0, b: 0 });
    const white = await makeSolidJpeg(32, 32, { r: 255, g: 255, b: 255 });

    expect(await detector.processFrame(black, 0)).toBeNull();
    detector.reset();
    // reset 后 white 作为新基线，返回 null
    expect(await detector.processFrame(white, 100)).toBeNull();
  });
});
