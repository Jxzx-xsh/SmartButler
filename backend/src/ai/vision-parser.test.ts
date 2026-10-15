/** 视觉物品识别器单元测试（注入 mock client 与固定时钟，不触网、确定性） */

import { describe, expect, it, vi } from 'vitest';

import { createVisionParser } from './vision-parser.js';
import { LmStudioError } from './errors.js';
import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';

/** 固定时钟：2025-01-01T12:00:00+08:00（周三）。 */
const FIXED_NOW = Date.parse('2025-01-01T12:00:00+08:00');

/** 构造一个只实现 chatVisionJson 的 mock client；其余方法用不到，置为抛错桩。 */
function makeMockClient(chatVisionJson: ReturnType<typeof vi.fn>): LmStudioClient {
  const notUsed = (): never => {
    throw new Error('本测试不应调用该方法');
  };
  return {
    chatText: notUsed,
    chatTextJson: notUsed,
    chatVision: notUsed,
    chatVisionJson,
    embed: notUsed,
    listModels: notUsed,
  } as unknown as LmStudioClient;
}

/** 一帧假 JPEG 字节（内容无所谓，mock 不真算模型）。 */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('createVisionParser.parseFrame', () => {
  it('单物品识别成功，断言 images[0] 为 jpeg data URL、temperature=0', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [{ name: '牛奶', quantity: 2, unit: '盒', category: '乳制品' }],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 1700000000000);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: '牛奶', quantity: 2, unit: '盒', category: '乳制品' });

    const callArg = chatVisionJson.mock.calls[0]?.[0] as {
      images: string[];
      temperature: number;
      prompt: string;
    };
    expect(callArg.images[0]?.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(callArg.images[0]).toBe(`data:image/jpeg;base64,${FAKE_JPEG.toString('base64')}`);
    expect(callArg.temperature).toBe(0);
    // 注入的当前日期上下文确实在提示里（确定性）
    expect(callArg.prompt).toContain('2025-01-01');
    expect(callArg.prompt).toContain('周三');
  });

  it('多物品：items 数组多条都入列', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [{ name: '牛奶' }, { name: '鸡蛋' }, { name: '面包' }],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items.map((i) => i.name)).toEqual(['牛奶', '鸡蛋', '面包']);
  });

  it('日期 ISO 字符串经 normalizeToMillis 归一化为毫秒整数', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [{ name: '酸奶', expiryDate: '2025-01-10' }],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items[0]?.expiryDate).toBe(Date.parse('2025-01-10'));
    expect(Number.isInteger(items[0]?.expiryDate)).toBe(true);
  });

  it('name 为空白的条目被丢弃', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [{ name: '牛奶' }, { name: '   ' }, { name: '', quantity: 3 }, { name: '苹果' }],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items.map((i) => i.name)).toEqual(['牛奶', '苹果']);
  });

  it('识别不出（items 为空）返回 []', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({ items: [] });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items).toEqual([]);
  });

  it('注入 queue 时经 enqueueDeferred 提交一次且结果透传', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({ items: [{ name: '牛奶' }] });
    // mock 队列：enqueueDeferred 直接执行传入任务的 run
    const enqueueDeferred = vi.fn(
      async <T>(task: { run: () => Promise<T> }): Promise<T> => task.run(),
    );
    const queue = { enqueueDeferred } as unknown as AiQueue;

    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      queue,
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(enqueueDeferred).toHaveBeenCalledTimes(1);
    expect(chatVisionJson).toHaveBeenCalledTimes(1);
    expect(items[0]?.name).toBe('牛奶');
  });

  it('返回结构非法（items 非数组）抛 bad_response', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({ items: '不是数组' });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    await expect(parser.parseFrame(FAKE_JPEG, 123)).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
    await expect(parser.parseFrame(FAKE_JPEG, 123)).rejects.toBeInstanceOf(LmStudioError);
  });
});
