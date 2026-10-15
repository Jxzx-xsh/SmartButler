/**
 * 移动侦测（帧差法）。
 *
 * 处理来自采集网关 onFrame 回调的完整单帧 JPEG Buffer：先用 sharp 把每帧
 * 解码为固定尺寸的灰度缩略图（原始灰度像素 Uint8Array），再与上一帧逐像素
 * 比较，统计平均绝对差（MAD）与「变化像素占比」（changedRatio）；当
 * changedRatio 达到阈值并满足最小连续命中帧数与冷却间隔时产出一次 MotionEvent。
 *
 * 为什么用 sharp 做 JPEG 解码：
 *   sharp 基于原生 libvips，可在一次管线里完成「解码 + 缩放 + 灰度」，
 *   对连续帧流的高频处理延迟低、吞吐高；而纯 JS 的 jpeg-js 需要先把整帧
 *   按全分辨率解码到内存，再在 JS 侧降采样/转灰度，更慢且更吃内存。
 *   因此仅新增 sharp(0.35.5) 这一个原生依赖。
 * jpeg-js 纯 JS 回退路径：若将来部署环境装不上 sharp 的 libvips 二进制，
 *   可改用 jpeg-js 全分辨率解码后在 JS 里手动降采样+灰度——本任务不实现，
 *   仅在此说明可行方向。
 * 为什么不选 ffmpeg scene detection：帧已被网关解码/抽帧为独立 JPEG，
 *   再起 ffmpeg 子进程做 scene 检测会引入进程开销与时序耦合，且难以得到
 *   逐帧可控的 changedRatio/MAD 指标，不如在内存里直接做帧差简单可控。
 */

import sharp from 'sharp';

/**
 * 计算两帧灰度像素之间的差异（纯函数）。
 * @param prev 上一帧灰度像素（0..255）。
 * @param curr 当前帧灰度像素（0..255），长度须与 prev 相同。
 * @param perPixelDelta 判定单像素发生变化的灰度差阈值（0..255）。
 * @returns mad=平均绝对差（0..255）；changedRatio=差大于 perPixelDelta 的像素占比（0..1）。
 * @throws 两帧长度不等时抛错（上游应保证尺寸一致）。
 */
export function computeFrameDiff(
  prev: Uint8Array,
  curr: Uint8Array,
  perPixelDelta: number,
): { mad: number; changedRatio: number } {
  // 等长校验：帧差必须逐像素一一对应，长度不等视为上游错误
  if (prev.length !== curr.length) {
    throw new Error(`帧长度不一致：prev=${prev.length} curr=${curr.length}`);
  }

  const length = prev.length;
  // 空帧：无像素可比较，视为无差异
  if (length === 0) {
    return { mad: 0, changedRatio: 0 };
  }

  let absSum = 0;
  let changedCount = 0;
  for (let i = 0; i < length; i += 1) {
    // noUncheckedIndexedAccess 下索引结果可能为 undefined，用 ?? 0 兜底（循环已限定范围）
    const diff = Math.abs((curr[i] ?? 0) - (prev[i] ?? 0));
    absSum += diff;
    if (diff > perPixelDelta) {
      changedCount += 1;
    }
  }

  return {
    mad: absSum / length,
    changedRatio: changedCount / length,
  };
}

/** 一次移动侦测事件。 */
export interface MotionEvent {
  /** 事件时间戳（取触发帧的 timestamp，毫秒）。 */
  timestamp: number;
  /** 触发帧相对上一帧的变化像素占比（0..1）。 */
  changedRatio: number;
  /** 触发帧相对上一帧的平均绝对差（0..255）。 */
  mad: number;
  /** 触发帧的原始 JPEG Buffer（即传入 processFrame 的 buffer）。 */
  frame: Buffer;
}

/** 移动侦测器构造选项。 */
export interface MotionDetectorOptions {
  /** 变化像素比例阈值（0..1）。 */
  threshold: number;
  /** 灰度缩略图宽度（像素）。 */
  thumbWidth: number;
  /** 灰度缩略图高度（像素）。 */
  thumbHeight: number;
  /** 判定单像素变化的灰度差阈值（0..255）。 */
  perPixelDelta: number;
  /** 两次事件之间的冷却毫秒数。 */
  cooldownMs: number;
  /** 产出事件所需的最小连续命中帧数（最小 1）。 */
  minConsecutiveFrames: number;
}

/** 移动侦测器实例。 */
export interface MotionDetector {
  /**
   * 处理一帧 JPEG。首帧只建基线返回 null；之后与上一帧做帧差，
   * 满足阈值 + 最小连续命中 + 冷却时产出 MotionEvent，否则返回 null。
   */
  processFrame(jpegBuffer: Buffer, timestamp: number): Promise<MotionEvent | null>;
  /** 重置内部状态（基线、连续计数、上次事件时间）。 */
  reset(): void;
}

/**
 * 创建一个移动侦测器。
 * @param options 阈值、缩略图尺寸、单像素差、冷却与最小连续命中帧数。
 */
export function createMotionDetector(options: MotionDetectorOptions): MotionDetector {
  const { threshold, thumbWidth, thumbHeight, perPixelDelta, cooldownMs, minConsecutiveFrames } = options;

  // 上一帧灰度基线；null 表示尚无基线（首帧）
  let baseline: Uint8Array | null = null;
  // 连续达到阈值的命中计数
  let consecutiveHits = 0;
  // 上次产出事件的时间戳；null 表示尚未产出过
  let lastEventAt: number | null = null;

  return {
    async processFrame(jpegBuffer: Buffer, timestamp: number): Promise<MotionEvent | null> {
      // 用 sharp 一步完成：灰度化 + 缩放到固定缩略图尺寸 + 取原始像素
      const raw = await sharp(jpegBuffer)
        .greyscale()
        .resize(thumbWidth, thumbHeight, { fit: 'fill' })
        .raw()
        .toBuffer();
      // 灰度单通道，每像素 1 字节，直接作为 Uint8Array 使用
      const current = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

      // 首帧：只建立基线，不产出事件
      if (baseline === null) {
        baseline = current;
        return null;
      }

      const { mad, changedRatio } = computeFrameDiff(baseline, current, perPixelDelta);

      // 无论是否出事件，都把当前帧设为新基线（滑动基线，比固定首帧更贴近实时变化）
      baseline = current;

      let event: MotionEvent | null = null;
      if (changedRatio >= threshold) {
        consecutiveHits += 1;
        // 达到最小连续命中帧数后，再检查冷却间隔
        if (consecutiveHits >= minConsecutiveFrames) {
          const cooledDown = lastEventAt === null || timestamp - lastEventAt >= cooldownMs;
          if (cooledDown) {
            event = { timestamp, changedRatio, mad, frame: jpegBuffer };
            lastEventAt = timestamp;
            consecutiveHits = 0;
          }
        }
      } else {
        // 未达阈值：连续命中中断，计数清零
        consecutiveHits = 0;
      }

      return event;
    },
    reset(): void {
      baseline = null;
      consecutiveHits = 0;
      lastEventAt = null;
    },
  };
}
