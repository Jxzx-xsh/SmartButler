/**
 * 门控（Gating）配置集中读取。
 *
 * 门控用于在把帧/音频送入上层 AI 之前，先做轻量本地检测——
 * 移动侦测（帧差法）与语音活动检测（VAD，能量阈值状态机），
 * 以过滤静止画面与静音，降低误触发与 AI 调用成本。
 * 范式对齐 src/capture/config.ts / src/ai/config.ts：
 * Number 解析 + Number.isFinite + 边界判断 + NaN/非法回退默认常量。
 */

/** 门控配置。 */
export interface GatingConfig {
  /** 变化像素比例阈值（0..1）：changedRatio ≥ 此值视为一次运动命中。缺省 0.08。 */
  motionThreshold: number;
  /** 移动侦测灰度缩略图宽度（像素）。缺省 64。 */
  motionThumbWidth: number;
  /** 移动侦测灰度缩略图高度（像素）。缺省 48。 */
  motionThumbHeight: number;
  /** 判定单像素发生变化的灰度差阈值（0..255）。缺省 24。 */
  motionPerPixelDelta: number;
  /** 两次运动事件之间的冷却毫秒数。缺省 1500。 */
  motionCooldownMs: number;
  /** 产出一次运动事件所需的最小连续命中帧数（最小 1）。缺省 1。 */
  motionMinConsecutiveFrames: number;
  /** VAD 能量（RMS）阈值（0..32767）：帧 RMS 超过此值视为有声。缺省 500。 */
  vadEnergyThreshold: number;
  /** VAD 帧长（毫秒），限制在 20..30。缺省 20。 */
  vadFrameMs: number;
  /** 连续超阈值累计达此时长（ms）进入 speech 态。缺省 150。 */
  vadTriggerMs: number;
  /** 连续低于阈值累计达此时长（ms）回到 silence 态。缺省 600。 */
  vadHangoverMs: number;
  /** 段时长小于此值（ms）的过短事件丢弃。缺省 300。 */
  vadMinEventMs: number;
  /** 两段语音事件之间的冷却毫秒数。缺省 500。 */
  vadCooldownMs: number;
}

/** 变化像素比例阈值默认值。 */
const DEFAULT_MOTION_THRESHOLD = 0.08;
/** 灰度缩略图宽度默认值。 */
const DEFAULT_MOTION_THUMB_WIDTH = 64;
/** 灰度缩略图高度默认值。 */
const DEFAULT_MOTION_THUMB_HEIGHT = 48;
/** 单像素变化灰度差默认值。 */
const DEFAULT_MOTION_PER_PIXEL_DELTA = 24;
/** 运动事件冷却毫秒默认值。 */
const DEFAULT_MOTION_COOLDOWN_MS = 1500;
/** 最小连续命中帧数默认值。 */
const DEFAULT_MOTION_MIN_CONSECUTIVE_FRAMES = 1;
/** VAD 能量阈值默认值。 */
const DEFAULT_VAD_ENERGY_THRESHOLD = 500;
/** VAD 帧长默认值（ms）。 */
const DEFAULT_VAD_FRAME_MS = 20;
/** VAD 帧长下限（ms）。 */
const MIN_VAD_FRAME_MS = 20;
/** VAD 帧长上限（ms）。 */
const MAX_VAD_FRAME_MS = 30;
/** VAD 进入 speech 的触发时长默认值（ms）。 */
const DEFAULT_VAD_TRIGGER_MS = 150;
/** VAD 回到 silence 的挂起时长默认值（ms）。 */
const DEFAULT_VAD_HANGOVER_MS = 600;
/** VAD 最小事件时长默认值（ms）。 */
const DEFAULT_VAD_MIN_EVENT_MS = 300;
/** VAD 事件冷却毫秒默认值。 */
const DEFAULT_VAD_COOLDOWN_MS = 500;

/**
 * 从环境变量读取门控配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadGatingConfig(env: NodeJS.ProcessEnv = process.env): GatingConfig {
  // 变化像素比例阈值：Number 解析；非法（NaN）或 ≤0 或 >1 统一回退默认
  const parsedMotionThreshold = Number(env.MOTION_THRESHOLD);
  const motionThreshold =
    Number.isFinite(parsedMotionThreshold) && parsedMotionThreshold > 0 && parsedMotionThreshold <= 1
      ? parsedMotionThreshold
      : DEFAULT_MOTION_THRESHOLD;

  // 缩略图宽度：Number 解析；非法（NaN）或 ≤0 回退默认
  const parsedThumbWidth = Number(env.MOTION_THUMB_WIDTH);
  const motionThumbWidth =
    Number.isFinite(parsedThumbWidth) && parsedThumbWidth > 0
      ? Math.floor(parsedThumbWidth)
      : DEFAULT_MOTION_THUMB_WIDTH;

  // 缩略图高度：Number 解析；非法（NaN）或 ≤0 回退默认
  const parsedThumbHeight = Number(env.MOTION_THUMB_HEIGHT);
  const motionThumbHeight =
    Number.isFinite(parsedThumbHeight) && parsedThumbHeight > 0
      ? Math.floor(parsedThumbHeight)
      : DEFAULT_MOTION_THUMB_HEIGHT;

  // 单像素变化灰度差：Number 解析；非法（NaN）或 <0 或 >255 回退默认
  const parsedPerPixelDelta = Number(env.MOTION_PER_PIXEL_DELTA);
  const motionPerPixelDelta =
    Number.isFinite(parsedPerPixelDelta) && parsedPerPixelDelta >= 0 && parsedPerPixelDelta <= 255
      ? parsedPerPixelDelta
      : DEFAULT_MOTION_PER_PIXEL_DELTA;

  // 运动冷却：Number 解析；非法（NaN）或 <0 回退默认
  const parsedMotionCooldown = Number(env.MOTION_COOLDOWN_MS);
  const motionCooldownMs =
    Number.isFinite(parsedMotionCooldown) && parsedMotionCooldown >= 0
      ? parsedMotionCooldown
      : DEFAULT_MOTION_COOLDOWN_MS;

  // 最小连续命中帧数：Number 解析；非法（NaN）或 <1 回退默认（下限 1）
  const parsedMinFrames = Number(env.MOTION_MIN_CONSECUTIVE_FRAMES);
  const motionMinConsecutiveFrames =
    Number.isFinite(parsedMinFrames) && parsedMinFrames >= 1
      ? Math.floor(parsedMinFrames)
      : DEFAULT_MOTION_MIN_CONSECUTIVE_FRAMES;

  // VAD 能量阈值：Number 解析；非法（NaN）或 <0 或 >32767 回退默认
  const parsedEnergy = Number(env.VAD_ENERGY_THRESHOLD);
  const vadEnergyThreshold =
    Number.isFinite(parsedEnergy) && parsedEnergy >= 0 && parsedEnergy <= 32767
      ? parsedEnergy
      : DEFAULT_VAD_ENERGY_THRESHOLD;

  // VAD 帧长：Number 解析；合法则夹到 [20,30]；非法（NaN）回退默认
  const parsedFrameMs = Number(env.VAD_FRAME_MS);
  const vadFrameMs = Number.isFinite(parsedFrameMs)
    ? Math.min(MAX_VAD_FRAME_MS, Math.max(MIN_VAD_FRAME_MS, parsedFrameMs))
    : DEFAULT_VAD_FRAME_MS;

  // VAD 触发时长：Number 解析；非法（NaN）或 ≤0 回退默认
  const parsedTriggerMs = Number(env.VAD_TRIGGER_MS);
  const vadTriggerMs =
    Number.isFinite(parsedTriggerMs) && parsedTriggerMs > 0 ? parsedTriggerMs : DEFAULT_VAD_TRIGGER_MS;

  // VAD 挂起时长：Number 解析；非法（NaN）或 ≤0 回退默认
  const parsedHangoverMs = Number(env.VAD_HANGOVER_MS);
  const vadHangoverMs =
    Number.isFinite(parsedHangoverMs) && parsedHangoverMs > 0 ? parsedHangoverMs : DEFAULT_VAD_HANGOVER_MS;

  // VAD 最小事件时长：Number 解析；非法（NaN）或 <0 回退默认
  const parsedMinEventMs = Number(env.VAD_MIN_EVENT_MS);
  const vadMinEventMs =
    Number.isFinite(parsedMinEventMs) && parsedMinEventMs >= 0 ? parsedMinEventMs : DEFAULT_VAD_MIN_EVENT_MS;

  // VAD 冷却：Number 解析；非法（NaN）或 <0 回退默认
  const parsedVadCooldown = Number(env.VAD_COOLDOWN_MS);
  const vadCooldownMs =
    Number.isFinite(parsedVadCooldown) && parsedVadCooldown >= 0 ? parsedVadCooldown : DEFAULT_VAD_COOLDOWN_MS;

  return {
    motionThreshold,
    motionThumbWidth,
    motionThumbHeight,
    motionPerPixelDelta,
    motionCooldownMs,
    motionMinConsecutiveFrames,
    vadEnergyThreshold,
    vadFrameMs,
    vadTriggerMs,
    vadHangoverMs,
    vadMinEventMs,
    vadCooldownMs,
  };
}
