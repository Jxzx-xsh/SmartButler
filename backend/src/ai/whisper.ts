/**
 * 本地 whisper.cpp 语音转写（STT）。
 *
 * 用 spawn 调起本地 whisper.cpp 命令（whisper-cli）完成转写，取代原先调 LM Studio
 * 音频端点的方案（该 LM Studio 版本尚未发布音频转写）。
 *
 * 环境约定（brew install whisper-cpp / ffmpeg）：
 * - whisper-cli 只接受 flac/mp3/ogg/wav，故非 wav 一律先经 normalizeAudio（ffmpeg）
 *   转成 16kHz 单声道 wav；
 * - whisper-cli 需要 ggml `.bin` 模型（不是 GGUF）；
 * - 用法：`whisper-cli -m <model.bin> -l <lang> -f <audio.wav> -otxt -of <输出前缀>`。
 *
 * 输出方式：本实现用 `-otxt -of <前缀>`，让 whisper-cli 把纯转写文本写入
 * `<前缀>.txt`，读文件 trim 即得干净文本；而非 `-nt` 从 stdout 抠文本——因为
 * stdout/stderr 会混入加载日志、进度与系统信息，解析脆弱。代价是多一个临时文件，
 * 用 fs.mkdtemp 建临时目录并在 finally 清理即可。
 *
 * 错误处理复用 LmStudioError（而非新建 WhisperError）：voice 路由已按
 * LmStudioError.kind 分流到 503/502/500，复用它则路由错误分支零改动、
 * {error:{message,code}} 契约不变。映射见各抛错处注释。
 */

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeAudio } from './audio.js';
import { loadAiConfig, type AiConfig } from './config.js';
import { LmStudioError } from './errors.js';

/** transcribe（语音转写）入参。 */
export interface WhisperTranscribeOptions {
  /** 待转写音频：Buffer（已读入内存）或本地文件路径（string） */
  audio: Buffer | string;
  /** 语言提示，缺省 config.whisperLanguage（即 'zh'） */
  language?: string;
}

/** 对外转写器接口。 */
export interface WhisperTranscriber {
  /** 语音转写，返回识别出的文本（已 trim） */
  transcribe(opts: WhisperTranscribeOptions): Promise<string>;
}

/** createWhisperTranscriber 依赖注入入参。 */
export interface CreateWhisperTranscriberDeps {
  /** AI 配置，缺省调用 loadAiConfig() */
  config?: AiConfig;
  /** 音频规范化函数，缺省用 audio.ts 的 normalizeAudio（测试注入可避开真实 ffmpeg） */
  normalize?: typeof normalizeAudio;
  /** 子进程 spawn 函数，缺省用 node:child_process 的 spawn（测试注入 fake 可避开真实二进制） */
  spawnFn?: typeof spawn;
}

/** 转写超时：首次加载模型较慢（Metal 下仍需读入数百 MB），给到 120s。 */
const DEFAULT_TIMEOUT_MS = 120000;

/** stderr 摘要最大长度，避免错误信息过长。 */
const STDERR_SUMMARY_MAX = 500;

/**
 * 创建本地 whisper.cpp 转写器。
 * @param deps 可选依赖：config、normalize、spawnFn（均供测试注入）。
 */
export function createWhisperTranscriber(deps: CreateWhisperTranscriberDeps = {}): WhisperTranscriber {
  const config = deps.config ?? loadAiConfig();
  const normalize = deps.normalize ?? normalizeAudio;
  const spawnFn = deps.spawnFn ?? spawn;

  async function transcribe(opts: WhisperTranscribeOptions): Promise<string> {
    const lang = opts.language ?? config.whisperLanguage;
    const modelPath = config.whisperModelPath;

    // (a) 预检模型文件：不存在则给出带绝对路径与获取指引的清晰报错（connection → 503）
    try {
      await access(modelPath);
    } catch (err) {
      throw new LmStudioError(
        `whisper 模型文件不存在：${modelPath}（须为 ggml .bin，不是 GGUF，可从 huggingface.co/ggerganov/whisper.cpp 获取）`,
        'connection',
        err,
      );
    }

    // (b) 规范化为 wav：whisper-cli 只吃 flac/mp3/ogg/wav，统一经 ffmpeg 转 16kHz
    //     单声道 wav（简单起见一律 normalize，复用成熟转码，幂等且开销小）。
    const wavBuffer = await normalize(opts.audio);

    // (c) 建临时工作目录，写入 wav，约定输出前缀；finally 统一清理
    const tmpDir = await mkdtemp(join(tmpdir(), 'whisper-'));
    const wavPath = join(tmpDir, 'audio.wav');
    const outPrefix = join(tmpDir, 'out');
    const outTxtPath = `${outPrefix}.txt`;

    try {
      await writeFile(wavPath, wavBuffer);

      // (d) spawn whisper-cli——数组参数防注入，绝不拼接 shell 字符串
      const args = ['-m', modelPath, '-l', lang, '-f', wavPath, '-otxt', '-of', outPrefix];
      await runWhisper(spawnFn, config.whisperCliPath, args);

      // (e) 读临时 txt、trim；空串视为异常
      const text = (await readFile(outTxtPath, 'utf8')).trim();
      if (text.length === 0) {
        throw new LmStudioError('whisper 返回空转写文本', 'bad_response');
      }
      return text;
    } finally {
      // (f) 清理临时目录；吞清理异常，不掩盖主错误
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { transcribe };
}

/**
 * 运行 whisper-cli 子进程，等待其正常退出（退出码 0）。
 *
 * 错误映射（复用 LmStudioError.kind）：
 * - spawn ENOENT（未安装 whisper.cpp）→ connection（→ 503 STT_UNAVAILABLE）；
 * - 其他 spawn error → connection；
 * - 非零退出 → bad_response（→ 502 STT_BAD_RESPONSE），带 stderr 摘要；
 * - 超时 → timeout（→ 503），SIGKILL 子进程。
 */
function runWhisper(spawnFn: typeof spawn, cliPath: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(cliPath, args as string[]);

    const stderrChunks: Buffer[] = [];
    let settled = false;

    // 超时保护：到点杀进程并以超时错误 reject
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(new LmStudioError(`whisper 转写超时（超过 ${DEFAULT_TIMEOUT_MS}ms）`, 'timeout'));
    }, DEFAULT_TIMEOUT_MS);

    // stderr 可能为空（取决于 spawn 替身），用可选链保护
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // stdout 不解析（用 -otxt 读文件），直接丢弃避免管道缓冲占用
    child.stdout?.resume();

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 二进制不存在：带安装指引的清晰报错
      if (err.code === 'ENOENT') {
        reject(new LmStudioError('未安装 whisper.cpp（brew install whisper-cpp）', 'connection', err));
        return;
      }
      reject(new LmStudioError(`whisper 子进程启动失败：${err.message}`, 'connection', err));
    });

    child.on('close', (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      // 非零退出：带 stderr 摘要便于定位（截断避免过长）
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const summary = stderr.length > STDERR_SUMMARY_MAX ? `${stderr.slice(0, STDERR_SUMMARY_MAX)}…` : stderr;
      reject(new LmStudioError(`whisper 转写失败（退出码 ${code}）：${summary}`, 'bad_response'));
    });
  });
}
