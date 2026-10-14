/** 本地 whisper.cpp 转写器单元测试（mock spawn，不依赖真实 whisper-cli / 模型 / ffmpeg） */

import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWhisperTranscriber } from './whisper.js';
import { LmStudioError } from './errors.js';
import type { AiConfig } from './config.js';

/**
 * fake 子进程：EventEmitter + stdout/stderr（也是 EventEmitter）+ kill。
 * 由测试用 behavior 回调驱动 close/error 事件，并在成功分支里写出 <前缀>.txt。
 */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { resume: () => {} });
  stderr = new EventEmitter();
  kill = vi.fn();
}

/** 一个指向存在文件的模型路径（临时建一个假 .bin，仅为通过 fs.access 预检）。 */
let modelPath: string;
let modelDir: string;

beforeEach(async () => {
  modelDir = await mkdtemp(join(tmpdir(), 'whisper-model-'));
  modelPath = join(modelDir, 'ggml-small.bin');
  await writeFile(modelPath, Buffer.from('fake-model'));
});

afterEach(async () => {
  await rm(modelDir, { recursive: true, force: true }).catch(() => {});
});

/** 构造测试配置：模型路径指向上面的假文件（可被 override）。 */
function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    baseUrl: 'http://test:1234/v1',
    apiKey: 'test-key',
    textModel: 'text-model',
    visionModel: 'vision-model',
    embedModel: 'embed-model',
    sttModel: 'stt-model',
    timeoutMs: 1000,
    whisperCliPath: 'whisper-cli',
    whisperModelPath: modelPath,
    whisperLanguage: 'zh',
    ...overrides,
  };
}

/** 固定返回一段 wav Buffer 的 normalize 替身，避免真实 ffmpeg。 */
const fakeNormalize = vi.fn(async () => Buffer.from('fake-wav-bytes'));

afterEach(() => {
  vi.clearAllMocks();
});

describe('createWhisperTranscriber.transcribe', () => {
  it('正常转写：spawn 成功、写出 txt，返回 trim 后文本，且参数数组正确（防注入）', async () => {
    const child = new FakeChild();
    let capturedArgs: string[] = [];
    const spawnFn = vi.fn((_cli: string, args: string[]) => {
      capturedArgs = args;
      // 在下一个 microtask 里写出 <前缀>.txt 并 close(0)
      queueMicrotask(async () => {
        // 参数倒数第一个是输出前缀（-of 之后）
        const outPrefix = args[args.length - 1] as string;
        await writeFile(`${outPrefix}.txt`, '  我买了两盒牛奶\n');
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const out = await transcriber.transcribe({ audio: Buffer.from('input') });
    expect(out).toBe('我买了两盒牛奶');

    // 非 wav/Buffer 输入先走 normalizeAudio
    expect(fakeNormalize).toHaveBeenCalledOnce();

    // 断言 spawn 收到的 cli 与参数：-m <模型> -l zh -f <wav> -otxt -of <前缀>
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls[0]?.[0]).toBe('whisper-cli');
    expect(capturedArgs[0]).toBe('-m');
    expect(capturedArgs[1]).toBe(modelPath);
    expect(capturedArgs[2]).toBe('-l');
    expect(capturedArgs[3]).toBe('zh');
    expect(capturedArgs[4]).toBe('-f');
    expect(capturedArgs[6]).toBe('-otxt');
    expect(capturedArgs[7]).toBe('-of');
    // -f 的值（wav 路径）与 -of 的值（输出前缀）均为临时目录下路径
    expect(capturedArgs[5]).toContain('audio.wav');
  });

  it('language 透传：显式 en 时参数含 -l en', async () => {
    const child = new FakeChild();
    let capturedArgs: string[] = [];
    const spawnFn = vi.fn((_cli: string, args: string[]) => {
      capturedArgs = args;
      queueMicrotask(async () => {
        const outPrefix = args[args.length - 1] as string;
        await writeFile(`${outPrefix}.txt`, 'hello');
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const out = await transcriber.transcribe({ audio: Buffer.from('x'), language: 'en' });
    expect(out).toBe('hello');
    expect(capturedArgs[2]).toBe('-l');
    expect(capturedArgs[3]).toBe('en');
  });

  it('模型文件不存在：抛 connection 且 message 含模型路径', async () => {
    const missing = join(modelDir, 'does-not-exist.bin');
    const spawnFn = vi.fn();
    const transcriber = createWhisperTranscriber({
      config: makeConfig({ whisperModelPath: missing }),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const err = await transcriber.transcribe({ audio: Buffer.from('x') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect((err as LmStudioError).kind).toBe('connection');
    expect((err as LmStudioError).message).toContain(missing);
    // 模型预检失败时不应 spawn，也不应 normalize
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('whisper-cli 未安装（spawn ENOENT）：抛 connection 且 message 含安装指引', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        const err = Object.assign(new Error('spawn whisper-cli ENOENT'), { code: 'ENOENT' });
        child.emit('error', err);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const err = await transcriber.transcribe({ audio: Buffer.from('x') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect((err as LmStudioError).kind).toBe('connection');
    expect((err as LmStudioError).message).toContain('brew install whisper-cpp');
  });

  it('非零退出：抛 bad_response 且 message 含退出码与 stderr', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('whisper: failed to load model'));
        child.emit('close', 1);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const err = await transcriber.transcribe({ audio: Buffer.from('x') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect((err as LmStudioError).kind).toBe('bad_response');
    expect((err as LmStudioError).message).toContain('1');
    expect((err as LmStudioError).message).toContain('failed to load model');
  });

  it('空转写：spawn 成功但 txt 为空，抛 bad_response', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn((_cli: string, args: string[]) => {
      queueMicrotask(async () => {
        const outPrefix = args[args.length - 1] as string;
        await writeFile(`${outPrefix}.txt`, '   \n');
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    const err = await transcriber.transcribe({ audio: Buffer.from('x') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect((err as LmStudioError).kind).toBe('bad_response');
  });

  it('非 wav 输入会先调用 normalizeAudio', async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn((_cli: string, args: string[]) => {
      queueMicrotask(async () => {
        const outPrefix = args[args.length - 1] as string;
        await writeFile(`${outPrefix}.txt`, 'ok');
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });
    const normalize = vi.fn(async (_input: Buffer | string) => Buffer.from('normalized-wav'));

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    // 传一个任意（非 wav）输入，断言 normalize 被调用且入参透传
    const input = Buffer.from('webm-bytes');
    await transcriber.transcribe({ audio: input });
    expect(normalize).toHaveBeenCalledOnce();
    expect(normalize).toHaveBeenCalledWith(input);
  });

  it('转写成功后清理临时目录（txt 文件不残留）', async () => {
    const child = new FakeChild();
    let outPrefixSeen = '';
    const spawnFn = vi.fn((_cli: string, args: string[]) => {
      outPrefixSeen = args[args.length - 1] as string;
      queueMicrotask(async () => {
        await writeFile(`${outPrefixSeen}.txt`, 'done');
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    });

    const transcriber = createWhisperTranscriber({
      config: makeConfig(),
      normalize: fakeNormalize,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
    });

    await transcriber.transcribe({ audio: Buffer.from('x') });
    // 临时 txt 应已被清理
    await expect(access(`${outPrefixSeen}.txt`)).rejects.toBeTruthy();
  });
});
