/** 音频规范化（ffmpeg）单元测试 */

import { describe, expect, it } from 'vitest';

import { isFfmpegAvailable, normalizeAudio } from './audio.js';

/** 指向一个必定不存在的二进制路径，用于稳定复现 ffmpeg 不可用分支 */
const NONEXISTENT_FFMPEG = '/nonexistent/ffmpeg';

/**
 * 构造一段极短（约 0.01s）的静音 16-bit PCM 单声道 WAV Buffer，
 * 作为真实转码用例的输入（仅在 ffmpeg 可用时才用到）。
 */
function makeSilentWav(): Buffer {
  const sampleRate = 16000;
  const numSamples = 160; // 0.01s
  const bytesPerSample = 2; // 16-bit
  const dataSize = numSamples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF 头
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  // fmt 子块
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // 子块大小
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // 字节率
  buffer.writeUInt16LE(bytesPerSample, 32); // 块对齐
  buffer.writeUInt16LE(16, 34); // 位深
  // data 子块（全零=静音）
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe('isFfmpegAvailable', () => {
  it('二进制不存在时返回 false', async () => {
    await expect(isFfmpegAvailable(NONEXISTENT_FFMPEG)).resolves.toBe(false);
  });
});

describe('normalizeAudio - ffmpeg 不可用分支', () => {
  it('ffmpeg 不存在时抛含 brew install ffmpeg 文案的错误', async () => {
    await expect(normalizeAudio(Buffer.from('whatever'), { ffmpegPath: NONEXISTENT_FFMPEG })).rejects.toThrow(
      /brew install ffmpeg/,
    );
  });
});

describe('normalizeAudio - 真实转码（需 ffmpeg）', () => {
  it('ffmpeg 可用时输出非空 WAV Buffer（RIFF 头）', async () => {
    const available = await isFfmpegAvailable();
    // 运行环境无 ffmpeg 则跳过真实转码用例，避免因缺少外部二进制导致失败
    if (!available) {
      return;
    }
    const out = await normalizeAudio(makeSilentWav());
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    // WAV 容器以 ASCII 'RIFF' 开头
    expect(out.subarray(0, 4).toString('ascii')).toBe('RIFF');
  });
});
