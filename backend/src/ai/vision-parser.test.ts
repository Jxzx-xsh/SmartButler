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

  it('quantity 为字符串 "2" 容错归一化为数字 2，不再整条失败', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [
        { name: '牛奶', quantity: '2', unit: '盒' },
        { name: '鸡蛋', quantity: 10, unit: '个' },
        { name: '苹果', quantity: '5', unit: '个' },
      ],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.quantity)).toEqual([2, 10, 5]);
    // 全部归一化为整数
    for (const i of items) {
      expect(Number.isInteger(i.quantity)).toBe(true);
    }
  });

  it('quantity 带空格字符串 " 3 " 与小数字符串 "2.9" 归一化为整数 3 / 2', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [
        { name: '可乐', quantity: ' 3 ' },
        { name: '雪碧', quantity: '2.9' },
      ],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items.map((i) => i.quantity)).toEqual([3, 2]);
  });

  it('quantity 为非数字文本（如「两盒」）忽略该字段、该条仍入列', async () => {
    const chatVisionJson = vi.fn().mockResolvedValue({
      items: [{ name: '盐', quantity: '两盒', unit: '盒' }],
    });
    const parser = createVisionParser({
      client: makeMockClient(chatVisionJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parseFrame(FAKE_JPEG, 123);
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe('盐');
    expect(items[0]?.unit).toBe('盒');
    // 字段应被忽略（对象上不存在 quantity 键）
    expect(items[0]?.quantity).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(items[0], 'quantity')).toBe(false);
  });

  it('带 queue 与不带 queue 的 parseFrame 返回值行为一致（含 quantity 字符串容错）', async () => {
    const modelResponse = {
      items: [
        { name: '牛奶', quantity: '2', unit: '盒', category: '乳制品' },
        { name: '鸡蛋', quantity: 10, unit: '个' },
      ],
    };

    // 不带 queue
    const parserNoQueue = createVisionParser({
      client: makeMockClient(vi.fn().mockResolvedValue(modelResponse)),
      now: () => FIXED_NOW,
    });
    const itemsNoQueue = await parserNoQueue.parseFrame(FAKE_JPEG, 123);

    // 带 queue：mock 队列把 enqueueDeferred 的 run() 返回值原样透传
    const enqueueDeferred = vi.fn(
      async <T>(task: { run: () => Promise<T> }): Promise<T> => task.run(),
    );
    const queue = { enqueueDeferred } as unknown as AiQueue;
    const parserWithQueue = createVisionParser({
      client: makeMockClient(vi.fn().mockResolvedValue(modelResponse)),
      queue,
      now: () => FIXED_NOW,
    });
    const itemsWithQueue = await parserWithQueue.parseFrame(FAKE_JPEG, 123);

    // 两者返回的物品数组深等（固化带/不带 queue 行为一致这一不变量）
    expect(itemsWithQueue).toEqual(itemsNoQueue);
    expect(itemsWithQueue.map((i) => i.quantity)).toEqual([2, 10]);
    expect(enqueueDeferred).toHaveBeenCalledTimes(1);
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
