/**
 * 采集网关配置集中读取。
 *
 * 采集相关参数都通过环境变量注入，缺省时回退到本地部署的合理默认值；
 * 这样部署方可按需用环境变量覆盖，而测试/开发无需额外配置即可运行。
 * 范式对齐 src/ai/config.ts：Number 解析 + NaN/非法回退默认值。
 */

/** 采集网关配置。 */
export interface CaptureConfig {
  /**
   * 采集源地址（ffmpeg -i 的输入），形如 http://<IP>:8080/video（MJPEG）
   * 或 rtsp://<IP>:554/stream。缺省 '' 表示不自动启动采集（由上层决定何时 start）。
   */
  sourceUrl: string;
  /** 视频抽帧帧率；缺省 2，非法（NaN）或 ≤0 回退 2。 */
  fps: number;
  /** ffmpeg 可执行文件路径或命令名；缺省 'ffmpeg'（走 PATH）。 */
  ffmpegPath: string;
  /** 断线重连前的等待毫秒数；缺省 2000，非法（NaN）或 ≤0 回退默认。 */
  reconnectDelayMs: number;
  /**
   * 自动重连的最大次数；缺省 10，负数表示无限重连，非法（NaN）回退默认。
   * 注意：0 表示不自动重连；正数到达上限后网关停止自动重连并保持状态可观测，
   * 需手动再 start() 恢复。家用设备（手机 IP Webcam）掉线是常态，建议配 -1。
   */
  maxReconnects: number;
  /**
   * 僵死判定阈值毫秒数；缺省 10000。connected 状态下超过该时长无新帧即认定
   * 半开连接僵死，强杀 ffmpeg 触发重连。0 或负数关闭看门狗。
   */
  stallTimeoutMs: number;
}

/** 音频常量：whisper 友好的 16kHz 单声道 PCM（s16le）。 */
export const AUDIO_SAMPLE_RATE = 16000;
/** 音频声道数：单声道。 */
export const AUDIO_CHANNELS = 1;
/** 音频采样格式：有符号 16 位小端 PCM。 */
export const AUDIO_FORMAT = 's16le';

/** 帧率默认值。 */
const DEFAULT_FPS = 2;
/** 重连等待毫秒默认值。 */
const DEFAULT_RECONNECT_DELAY_MS = 2000;
/** 最大重连次数默认值。 */
const DEFAULT_MAX_RECONNECTS = 10;
/** 僵死判定阈值默认值（毫秒）。 */
const DEFAULT_STALL_TIMEOUT_MS = 10000;

/**
 * 从环境变量读取采集配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadCaptureConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  // 帧率：Number 解析；非法（NaN）或 ≤0 统一回退默认
  const parsedFps = Number(env.CAPTURE_FPS);
  const fps = Number.isFinite(parsedFps) && parsedFps > 0 ? parsedFps : DEFAULT_FPS;

  // 重连等待：Number 解析；非法（NaN）或 ≤0 统一回退默认
  const parsedDelay = Number(env.CAPTURE_RECONNECT_DELAY_MS);
  const reconnectDelayMs =
    Number.isFinite(parsedDelay) && parsedDelay > 0 ? parsedDelay : DEFAULT_RECONNECT_DELAY_MS;

  // 最大重连次数：Number 解析；负数（如 -1）表示无限重连，非法或空串回退默认
  // （0 合法，表示不自动重连）
  const maxReconnects = parseNumberOrDefault(
    env.CAPTURE_MAX_RECONNECTS,
    DEFAULT_MAX_RECONNECTS,
    (n) => (n < 0 ? -1 : n),
  );

  // 僵死判定阈值：Number 解析；非法或空串回退默认；0/负数合法（表示关闭看门狗）
  const stallTimeoutMs = parseNumberOrDefault(
    env.CAPTURE_STALL_TIMEOUT_MS,
    DEFAULT_STALL_TIMEOUT_MS,
  );

  return {
    // 采集源地址：缺省空串表示不自动启动；可用 CAPTURE_SOURCE_URL 覆盖为实际拉流地址
    sourceUrl: env.CAPTURE_SOURCE_URL ?? '',
    fps,
    // ffmpeg 命令：缺省走 PATH 的 ffmpeg（brew 安装后在 /opt/homebrew/bin/ffmpeg）；
    // 可用 CAPTURE_FFMPEG_PATH 覆盖为绝对路径。
    ffmpegPath: env.CAPTURE_FFMPEG_PATH ?? 'ffmpeg',
    reconnectDelayMs,
    maxReconnects,
    stallTimeoutMs,
  };
}

/**
 * 把环境变量值解析为数字，未设置/空串/非法（NaN）时回退默认值。
 * @param raw 原始环境变量值
 * @param fallback 回退默认值
 * @param normalize 可选归一化函数，对解析成功的数字做进一步处理
 */
function parseNumberOrDefault(
  raw: string | undefined,
  fallback: number,
  normalize?: (n: number) => number,
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return normalize ? normalize(parsed) : parsed;
}
