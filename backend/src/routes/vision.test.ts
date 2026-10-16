/** 视觉入库路由集成测试（Fastify inject + 注入 mock VisionIngest） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { buildApp } from '../app.js';
import type { VisionIngest } from '../capture/vision-ingest.js';
import type { Item } from '../db/schema.js';

let app: FastifyInstance;
let db: AppDatabase;

/** 一条伪造的 vision 入库物品（断言 source/confirmed 用）。 */
function fakeVisionItem(): Item {
  const now = Date.now();
  return {
    id: 1,
    name: '牛奶',
    quantity: 2,
    unit: '盒',
    categoryId: null,
    location: null,
    purchaseDate: null,
    shelfLifeDays: null,
    expiryDate: null,
    confirmed: false,
    source: 'vision',
    note: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 构造 mock 视觉入库管线。 */
function makeMockIngest(overrides: Partial<VisionIngest> = {}): VisionIngest {
  return {
    ingestFrame: vi.fn().mockResolvedValue([fakeVisionItem()]),
    getStats: vi.fn().mockReturnValue({ lastIngestAt: 123, ingestedCount: 1 }),
    ...overrides,
  } as VisionIngest;
}

/** 构造一个含单个 file 字段（frame.jpg / image/jpeg）的 multipart/form-data 请求体。 */
function buildMultipart(fileContent: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----visiontestboundary1234567890';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="frame.jpg"\r\n' +
      'Content-Type: image/jpeg\r\n\r\n',
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

describe('POST /api/vision/ingest-frame', () => {
  it('multipart 上传 → 200 返回 items，item.source=vision/confirmed=false', async () => {
    const visionIngest = makeMockIngest();
    app = buildApp({ db, visionIngest });
    await app.ready();

    const { payload, headers } = buildMultipart(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const res = await app.inject({
      method: 'POST',
      url: '/api/vision/ingest-frame',
      payload,
      headers,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].source).toBe('vision');
    expect(body.items[0].confirmed).toBe(false);
    // quantity 为数字（容错归一化后流转到入库）
    expect(body.items[0].quantity).toBe(2);
    expect(visionIngest.ingestFrame).toHaveBeenCalledOnce();
  });

  it('base64 body（纯 base64）→ 200', async () => {
    const visionIngest = makeMockIngest();
    app = buildApp({ db, visionIngest });
    await app.ready();

    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/vision/ingest-frame',
      payload: { imageBase64: b64 },
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(visionIngest.ingestFrame).toHaveBeenCalledOnce();
  });

  it('base64 body（含 data URL 前缀）→ 200', async () => {
    const visionIngest = makeMockIngest();
    app = buildApp({ db, visionIngest });
    await app.ready();

    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/vision/ingest-frame',
      payload: { imageBase64: `data:image/jpeg;base64,${b64}` },
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(visionIngest.ingestFrame).toHaveBeenCalledOnce();
  });

  it('缺图（既无文件又无 imageBase64）→ 400 NO_IMAGE', async () => {
    const visionIngest = makeMockIngest();
    app = buildApp({ db, visionIngest });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/vision/ingest-frame',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_IMAGE');
    expect(visionIngest.ingestFrame).not.toHaveBeenCalled();
  });
});

describe('GET /api/vision/status', () => {
  it('返回 getStats 字段', async () => {
    const visionIngest = makeMockIngest();
    app = buildApp({ db, visionIngest });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/vision/status' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lastIngestAt).toBe(123);
    expect(body.ingestedCount).toBe(1);
  });
});
