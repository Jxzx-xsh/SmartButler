/** 视觉入库管线单测（内存库 + mock VisionParser + 可控 now） */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createCategory, listItems } from '../db/repository.js';
import { eventLogs } from '../db/schema.js';
import { createVisionIngest } from './vision-ingest.js';
import type { VisionParser } from '../ai/vision-parser.js';
import type { ParsedItem } from '../ai/item-parser.js';

let db: AppDatabase;

/** 构造一个只实现 parseFrame 的 mock 识别器。 */
function makeMockParser(parseFrame: VisionParser['parseFrame']): VisionParser {
  return { parseFrame } as VisionParser;
}

/** 一个占位 JPEG Buffer（内容不参与断言，mock parser 不解码）。 */
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

describe('createVisionIngest.ingestFrame', () => {
  it('成功入库：source=vision、confirmed=false，命中分类带 id、未命中为空', async () => {
    const cat = createCategory(db, { name: '乳制品' });
    const parsed: ParsedItem[] = [
      { name: '牛奶', quantity: 2, unit: '盒', category: '乳制品' },
      { name: '不知名物品', category: '不存在的分类' },
    ];
    const parseFrame = vi.fn().mockResolvedValue(parsed);
    const ingest = createVisionIngest({
      db,
      visionParser: makeMockParser(parseFrame),
      now: () => 1_000_000,
    });

    const items = await ingest.ingestFrame(fakeJpeg, 123);

    expect(items).toHaveLength(2);
    expect(items.every((i) => i.source === 'vision')).toBe(true);
    expect(items.every((i) => i.confirmed === false)).toBe(true);
    expect(items[0]?.name).toBe('牛奶');
    expect(items[0]?.categoryId).toBe(cat.id);
    // quantity 从识别结果流转入库为数字
    expect(items[0]?.quantity).toBe(2);
    // 分类名匹配不到时 categoryId 为空
    expect(items[1]?.categoryId).toBeNull();
  });

  it('最小间隔节流：间隔内第二次返回 []、不再调 parseFrame、落 vision_skip', async () => {
    let clock = 1_000_000;
    const parseFrame = vi.fn().mockResolvedValue([{ name: '牛奶' }] as ParsedItem[]);
    const ingest = createVisionIngest({
      db,
      visionParser: makeMockParser(parseFrame),
      now: () => clock,
      minIntervalMs: 15000,
    });

    const first = await ingest.ingestFrame(fakeJpeg, 1);
    expect(first).toHaveLength(1);
    expect(parseFrame).toHaveBeenCalledTimes(1);

    // 推进不足最小间隔 → 节流
    clock += 5000;
    const second = await ingest.ingestFrame(fakeJpeg, 2);
    expect(second).toEqual([]);
    // parseFrame 未被第二次调用
    expect(parseFrame).toHaveBeenCalledTimes(1);

    // 落了 vision_skip 事件（source='vision'）
    const skips = db
      .select()
      .from(eventLogs)
      .where(eq(eventLogs.eventType, 'vision_skip'))
      .all();
    expect(skips).toHaveLength(1);
    expect(skips[0]?.source).toBe('vision');
  });

  it('去重：窗口内同名跳过，过窗后同名可再入库', async () => {
    let clock = 1_000_000;
    const parseFrame = vi.fn().mockResolvedValue([{ name: '牛奶' }] as ParsedItem[]);
    const ingest = createVisionIngest({
      db,
      visionParser: makeMockParser(parseFrame),
      now: () => clock,
      minIntervalMs: 15000,
      dedupWindowMs: 60000,
    });

    // 第一次入库
    const first = await ingest.ingestFrame(fakeJpeg, 1);
    expect(first).toHaveLength(1);

    // 推进过最小间隔但仍在去重窗口内 → 同名被跳过
    clock += 20000;
    const second = await ingest.ingestFrame(fakeJpeg, 2);
    expect(second).toEqual([]);
    // parseFrame 被调用了（去重发生在识别之后）
    expect(parseFrame).toHaveBeenCalledTimes(2);

    // 推进过去重窗口 → 同名可再入库
    clock += 60001;
    const third = await ingest.ingestFrame(fakeJpeg, 3);
    expect(third).toHaveLength(1);

    // 共入库两条「牛奶」
    expect(listItems(db).filter((i) => i.name === '牛奶')).toHaveLength(2);
  });

  it('识别空结果：不建条目、返回 []', async () => {
    const parseFrame = vi.fn().mockResolvedValue([] as ParsedItem[]);
    const ingest = createVisionIngest({
      db,
      visionParser: makeMockParser(parseFrame),
      now: () => 1_000_000,
    });

    const items = await ingest.ingestFrame(fakeJpeg, 1);
    expect(items).toEqual([]);
    expect(listItems(db)).toHaveLength(0);
  });

  it('落 vision_ingest 事件（source=vision），getStats 反映 ingestedCount/lastIngestAt', async () => {
    let clock = 2_000_000;
    const parseFrame = vi
      .fn()
      .mockResolvedValue([{ name: '牛奶' }, { name: '鸡蛋' }] as ParsedItem[]);
    const ingest = createVisionIngest({
      db,
      visionParser: makeMockParser(parseFrame),
      now: () => clock,
    });

    await ingest.ingestFrame(fakeJpeg, 1);

    const ingests = db
      .select()
      .from(eventLogs)
      .where(eq(eventLogs.eventType, 'vision_ingest'))
      .all();
    expect(ingests).toHaveLength(1);
    expect(ingests[0]?.source).toBe('vision');
    const payload = JSON.parse(ingests[0]?.payload ?? '{}') as {
      count: number;
      names: string[];
    };
    expect(payload.count).toBe(2);
    expect(payload.names).toEqual(['牛奶', '鸡蛋']);

    const stats = ingest.getStats();
    expect(stats.ingestedCount).toBe(2);
    expect(stats.lastIngestAt).toBe(clock);
  });
});
