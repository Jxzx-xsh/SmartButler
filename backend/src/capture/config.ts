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
   * 自动重连的最大次数；缺省 10，非法（NaN）或 <0 回退默认。
   * 注意：到达上限后网关停止自动重连并保持状态可观测，需手动再 start() 恢复。
   */
  maxReconnects: number;
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

  // 最大重连次数：Number 解析；非法（NaN）或 <0 统一回退默认（0 合法，表示不自动重连）
  const parsedMax = Number(env.CAPTURE_MAX_RECONNECTS);
  const maxReconnects =
    Number.isFinite(parsedMax) && parsedMax >= 0 ? parsedMax : DEFAULT_MAX_RECONNECTS;

  return {
    // 采集源地址：缺省空串表示不自动启动；可用 CAPTURE_SOURCE_URL 覆盖为实际拉流地址
    sourceUrl: env.CAPTURE_SOURCE_URL ?? '',
    fps,
    // ffmpeg 命令：缺省走 PATH 的 ffmpeg（brew 安装后在 /opt/homebrew/bin/ffmpeg）；
    // 可用 CAPTURE_FFMPEG_PATH 覆盖为绝对路径。
    ffmpegPath: env.CAPTURE_FFMPEG_PATH ?? 'ffmpeg',
    reconnectDelayMs,
    maxReconnects,
  };
}
