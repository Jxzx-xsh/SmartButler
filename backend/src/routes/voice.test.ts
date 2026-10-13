/** 语音入库路由集成测试（Fastify inject + 注入 mock LmStudioClient） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import { LmStudioError } from '../ai/errors.js';
import { createCategory } from '../db/repository.js';
import type { LmStudioClient } from '../ai/lmstudio.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 构造一个仅实现所需方法的 mock 客户端。 */
function makeMockClient(overrides: Partial<LmStudioClient> = {}): LmStudioClient {
  return {
    chatText: vi.fn(),
    chatTextJson: vi.fn(),
    chatVision: vi.fn(),
    embed: vi.fn(),
    transcribe: vi.fn(),
    listModels: vi.fn(),
    ...overrides,
  } as LmStudioClient;
}

/** 构造一个 multipart/form-data 请求体，含单个文件字段 file。 */
function buildMultipart(fileContent: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----voicetestboundary1234567890';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n' +
      'Content-Type: audio/webm\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payload = Buffer.concat([head, fileContent, tail]);
  return {
    payload,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
  };
}

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/voice/ingest-text', () => {
  it('单物品：解析入库，source=voice，分类名映射到已有分类 id', async () => {
    // 预置分类
    const cat = createCategory(db, { name: '乳制品' });
    const client = makeMockClient({
      chatTextJson: vi.fn().mockResolvedValue({
        items: [
          {
            name: '牛奶',
            quantity: 2,
            unit: '盒',
            category: '乳制品',
            expiryDate: '2025-01-10',
          },
        ],
      }),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/ingest-text',
      payload: { text: '我买了两盒牛奶，保质期到下周五' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transcript).toBe('我买了两盒牛奶，保质期到下周五');
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item.name).toBe('牛奶');
    expect(item.quantity).toBe(2);
    expect(item.unit).toBe('盒');
    expect(item.source).toBe('voice');
    expect(item.confirmed).toBe(true);
    expect(item.categoryId).toBe(cat.id);
    expect(item.expiryDate).toBe(Date.parse('2025-01-10'));
  });

  it('多物品：多条都入库', async () => {
    const client = makeMockClient({
      chatTextJson: vi.fn().mockResolvedValue({
        items: [{ name: '鸡蛋', quantity: 10 }, { name: '面包', quantity: 1 }],
      }),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/ingest-text',
      payload: { text: '买了十个鸡蛋和一个面包' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { name: string }) => i.name)).toEqual(['鸡蛋', '面包']);
    expect(body.items.every((i: { source: string }) => i.source === 'voice')).toBe(true);
  });

  it('分类名匹配不到时 categoryId 为空', async () => {
    const client = makeMockClient({
      chatTextJson: vi.fn().mockResolvedValue({
        items: [{ name: '牛奶', category: '不存在的分类' }],
      }),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/ingest-text',
      payload: { text: '买了牛奶' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].categoryId).toBeNull();
  });

  it('text 为空时返回 400', async () => {
    const client = makeMockClient();
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/ingest-text',
      payload: { text: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/voice/ingest', () => {
  it('全链路：转写 + 解析入库，source=voice', async () => {
    const client = makeMockClient({
      // normalizeAudio 需要真实 ffmpeg——这里避开 ffmpeg，直接 mock transcribe 不足以绕过。
      transcribe: vi.fn().mockResolvedValue('买了两盒牛奶'),
      chatTextJson: vi.fn().mockResolvedValue({ items: [{ name: '牛奶', quantity: 2, unit: '盒' }] }),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    // 用一段极短静音 wav Buffer 作为上传内容；normalizeAudio 需要 ffmpeg，
    // 若本机无 ffmpeg 则该端点返回 503 FFMPEG_UNAVAILABLE，二者都在断言覆盖内。
    const wav = buildSilentWav();
    const { payload, headers } = buildMultipart(wav);
    const res = await app.inject({ method: 'POST', url: '/api/voice/ingest', payload, headers });

    if (res.statusCode === 503 && res.json().error?.code === 'FFMPEG_UNAVAILABLE') {
      // 本机无 ffmpeg：规范化不可用分支，转写不会被调用
      expect(client.transcribe).not.toHaveBeenCalled();
      return;
    }

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transcript).toBe('买了两盒牛奶');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('牛奶');
    expect(body.items[0].source).toBe('voice');
    expect(client.transcribe).toHaveBeenCalledOnce();
  });

  it('缺少音频文件时返回 400 NO_AUDIO', async () => {
    const client = makeMockClient();
    app = buildApp({ db, aiClient: client });
    await app.ready();

    // 构造一个只含普通字段、没有文件的 multipart body
    const boundary = '----noaudio';
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="foo"\r\n\r\n' +
        'bar\r\n' +
        `--${boundary}--\r\n`,
      'utf8',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/ingest',
      payload,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(payload.length),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_AUDIO');
  });

  it('transcribe 抛连接类 LmStudioError 时返回 503 STT_UNAVAILABLE', async () => {
    const client = makeMockClient({
      transcribe: vi.fn().mockRejectedValue(new LmStudioError('无法连接 LM Studio', 'connection')),
      chatTextJson: vi.fn(),
    });
    app = buildApp({ db, aiClient: client });
    await app.ready();

    const wav = buildSilentWav();
    const { payload, headers } = buildMultipart(wav);
    const res = await app.inject({ method: 'POST', url: '/api/voice/ingest', payload, headers });

    // 若本机无 ffmpeg，会先在规范化阶段返回 503 FFMPEG_UNAVAILABLE；
    // 有 ffmpeg 时才会走到 transcribe 并返回 STT_UNAVAILABLE。
    expect(res.statusCode).toBe(503);
    const code = res.json().error.code;
    expect(['STT_UNAVAILABLE', 'FFMPEG_UNAVAILABLE']).toContain(code);
  });
});

/** 生成一段最小合法的 WAV（44 字节头 + 极短静音数据），用作上传测试内容。 */
function buildSilentWav(): Buffer {
  const sampleRate = 16000;
  const numSamples = 160; // 10ms 静音
  const dataSize = numSamples * 2; // 16-bit 单声道
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  // 数据区保持为 0（静音）
  return buffer;
}
