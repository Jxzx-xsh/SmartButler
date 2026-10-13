/**
 * 音频规范化工具（基于外部 ffmpeg 二进制）。
 *
 * whisper 转写端点对输入音频格式较敏感，直接上传浏览器录制的
 * webm/opus/m4a 等容器常常失败或识别质量差。这里统一用 ffmpeg 把任意输入
 * 转码为 16kHz 单声道 WAV（whisper 期望的采样参数），再交给 transcribe 上传。
 *
 * ffmpeg 不随 npm 依赖安装，而是作为外部二进制（macOS 用 brew install ffmpeg）。
 * 因此提供 isFfmpegAvailable 供上层先行探测，normalizeAudio 在缺失时给出清晰报错。
 */

import { spawn } from 'node:child_process';

/** normalizeAudio 可选项。 */
export interface NormalizeAudioOptions {
  /** ffmpeg 可执行文件路径或命令名，缺省 'ffmpeg'（走 PATH） */
  ffmpegPath?: string;
  /** 转码超时毫秒数，超时杀进程并报错，缺省 20000ms */
  timeoutMs?: number;
}

/** 默认转码超时：留足处理一段较长录音的余量。 */
const DEFAULT_TIMEOUT_MS = 20000;

/** ffmpeg 缺失时的统一错误文案（含安装指引）。 */
const FFMPEG_UNAVAILABLE_MESSAGE = 'ffmpeg 不可用：需要安装 ffmpeg（brew install ffmpeg）';

/**
 * 探测 ffmpeg 是否可用。
 * 执行 `<ffmpeg> -version`，退出码 0 视为可用；ENOENT（未安装/路径错）或
 * 非零退出码一律视为不可用，返回 false（不抛错）。
 * @param ffmpegPath ffmpeg 可执行文件路径或命令名，缺省 'ffmpeg'。
 */
export function isFfmpegAvailable(ffmpegPath = 'ffmpeg'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegPath, ['-version']);
    // spawn 本身失败（如二进制不存在）会触发 error 事件
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    // 输出不关心，直接丢弃，避免管道缓冲占用
    child.stdout?.resume();
    child.stderr?.resume();
  });
}

/**
 * 把输入音频规范化为 16kHz 单声道 WAV 的 Buffer。
 *
 * @param input Buffer（已读入内存的音频）或本地文件路径（string）。
 * @param opts  可选 ffmpegPath / timeoutMs。
 * @returns     转码后的 WAV 字节 Buffer。
 * @throws      ffmpeg 不可用（ENOENT）、非零退出、超时时抛 Error。
 */
export function normalizeAudio(input: Buffer | string, opts: NormalizeAudioOptions = {}): Promise<Buffer> {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<Buffer>((resolve, reject) => {
    // 输入参数：Buffer 走 stdin（pipe:0），文件路径直接读文件
    const inputArg = typeof input === 'string' ? input : 'pipe:0';
    // 统一输出：单声道（-ac 1）、16kHz（-ar 16000）、WAV 容器，写到 stdout（pipe:1）
    const args = ['-hide_banner', '-loglevel', 'error', '-i', inputArg, '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'];

    const child = spawn(ffmpegPath, args);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    // 超时保护：到点杀进程并以超时错误 reject
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg 音频转码超时（超过 ${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 二进制不存在：给出带安装指引的清晰报错
      if (err.code === 'ENOENT') {
        reject(new Error(FFMPEG_UNAVAILABLE_MESSAGE));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      // 非零退出：带上 stderr 摘要便于定位（截断避免过长）
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const summary = stderr.length > 500 ? `${stderr.slice(0, 500)}…` : stderr;
      reject(new Error(`ffmpeg 音频转码失败（退出码 ${code}）：${summary}`));
    });

    // Buffer 输入：写入 stdin 后结束
    if (typeof input !== 'string') {
      child.stdin.on('error', () => {
        // stdin 写入错误（如进程已退出）交由 error/close 事件统一处理，这里吞掉以免未捕获
      });
      child.stdin.end(input);
    }
  });
}
