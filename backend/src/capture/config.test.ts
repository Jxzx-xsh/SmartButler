/** 采集网关配置单元测试（注入 env 对象，不依赖真实 process.env）。 */

import { describe, expect, it } from 'vitest';

import { AUDIO_CHANNELS, AUDIO_FORMAT, AUDIO_SAMPLE_RATE, loadCaptureConfig } from './config.js';

describe('loadCaptureConfig', () => {
  it('空 env：全部回退默认值，sourceUrl 为空串', () => {
    const cfg = loadCaptureConfig({});
    expect(cfg.sourceUrl).toBe('');
    expect(cfg.fps).toBe(2);
    expect(cfg.ffmpegPath).toBe('ffmpeg');
    expect(cfg.reconnectDelayMs).toBe(2000);
    expect(cfg.maxReconnects).toBe(10);
  });

  it('环境变量覆盖：各字段按注入值生效', () => {
    const cfg = loadCaptureConfig({
      CAPTURE_SOURCE_URL: 'http://192.168.1.10:8080/video',
      CAPTURE_FPS: '5',
      CAPTURE_FFMPEG_PATH: '/opt/homebrew/bin/ffmpeg',
      CAPTURE_RECONNECT_DELAY_MS: '3000',
      CAPTURE_MAX_RECONNECTS: '3',
    });
    expect(cfg.sourceUrl).toBe('http://192.168.1.10:8080/video');
    expect(cfg.fps).toBe(5);
    expect(cfg.ffmpegPath).toBe('/opt/homebrew/bin/ffmpeg');
    expect(cfg.reconnectDelayMs).toBe(3000);
    expect(cfg.maxReconnects).toBe(3);
  });

  it('非法 CAPTURE_FPS：非数字回退默认 2', () => {
    expect(loadCaptureConfig({ CAPTURE_FPS: 'abc' }).fps).toBe(2);
  });

  it('非法 CAPTURE_FPS：≤0 回退默认 2', () => {
    expect(loadCaptureConfig({ CAPTURE_FPS: '0' }).fps).toBe(2);
    expect(loadCaptureConfig({ CAPTURE_FPS: '-1' }).fps).toBe(2);
  });

  it('非法 CAPTURE_RECONNECT_DELAY_MS：非数字或 ≤0 回退默认 2000', () => {
    expect(loadCaptureConfig({ CAPTURE_RECONNECT_DELAY_MS: 'xyz' }).reconnectDelayMs).toBe(2000);
    expect(loadCaptureConfig({ CAPTURE_RECONNECT_DELAY_MS: '0' }).reconnectDelayMs).toBe(2000);
  });

  it('CAPTURE_MAX_RECONNECTS：0 合法（不自动重连），负数/非法回退默认 10', () => {
    expect(loadCaptureConfig({ CAPTURE_MAX_RECONNECTS: '0' }).maxReconnects).toBe(0);
    expect(loadCaptureConfig({ CAPTURE_MAX_RECONNECTS: '-5' }).maxReconnects).toBe(10);
    expect(loadCaptureConfig({ CAPTURE_MAX_RECONNECTS: 'foo' }).maxReconnects).toBe(10);
  });

  it('空 sourceUrl：显式空串保持为空串', () => {
    expect(loadCaptureConfig({ CAPTURE_SOURCE_URL: '' }).sourceUrl).toBe('');
  });

  it('音频常量：16kHz 单声道 s16le', () => {
    expect(AUDIO_SAMPLE_RATE).toBe(16000);
    expect(AUDIO_CHANNELS).toBe(1);
    expect(AUDIO_FORMAT).toBe('s16le');
  });
});
