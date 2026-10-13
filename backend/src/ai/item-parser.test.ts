/** 物品解析器单元测试（注入 mock client 与固定时钟，不触网、确定性） */

import { describe, expect, it, vi } from 'vitest';

import { createItemParser } from './item-parser.js';
import { LmStudioError } from './errors.js';
import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';

/** 固定时钟：2025-01-01T12:00:00+08:00（周三）。 */
const FIXED_NOW = Date.parse('2025-01-01T12:00:00+08:00');
/** 对应的「下周五」= 2025-01-03（最近一个晚于周三的周五）。 */
const NEXT_FRIDAY_MS = Date.parse('2025-01-03');

/** 构造一个只实现 chatTextJson 的 mock client；其余方法用不到，置为抛错桩。 */
function makeMockClient(chatTextJson: ReturnType<typeof vi.fn>): LmStudioClient {
  const notUsed = (): never => {
    throw new Error('本测试不应调用该方法');
  };
  return {
    chatText: notUsed,
    chatTextJson,
    chatVision: notUsed,
    embed: notUsed,
    transcribe: notUsed,
    listModels: notUsed,
  } as unknown as LmStudioClient;
}

describe('createItemParser.parse', () => {
  it('『下周五』稳定解析为正确未来周五的毫秒（模型返回绝对 ISO）', async () => {
    // 模拟模型按注入的当前日期把「下周五」换算为绝对日期 2025-01-03
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [{ name: '牛奶', quantity: 2, unit: '盒', expiryDate: '2025-01-03' }],
    });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parse('我买了两盒牛奶，保质期到下周五');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: '牛奶', quantity: 2, unit: '盒' });
    expect(items[0]?.expiryDate).toBe(NEXT_FRIDAY_MS);
  });

  it('跨周边界：今天是周六时『下周五』取下一周的周五', async () => {
    // 2025-01-04 为周六；下一个周五应为 2025-01-10
    const saturdayNow = Date.parse('2025-01-04T12:00:00+08:00');
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [{ name: '酸奶', expiryDate: '2025-01-10' }],
    });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => saturdayNow,
    });

    const items = await parser.parse('买了酸奶，下周五到期');

    expect(items[0]?.expiryDate).toBe(Date.parse('2025-01-10'));
    // 断言注入的当前日期上下文确实是周六 2025-01-04
    const system = chatTextJson.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('2025-01-04');
    expect(system).toContain('周六');
  });

  it('多物品：一句话买多样，items 数组多条都入列', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [
        { name: '牛奶', quantity: 2, unit: '盒' },
        { name: '鸡蛋', quantity: 10, unit: '个' },
        { name: '面包' },
      ],
    });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parse('买了牛奶鸡蛋和面包');

    expect(items.map((i) => i.name)).toEqual(['牛奶', '鸡蛋', '面包']);
  });

  it('name 缺失/空白的条目被丢弃', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [
        { name: '牛奶' },
        { name: '   ' },
        { name: '', quantity: 3 },
        { name: '苹果' },
      ],
    });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parse('一些东西');

    expect(items.map((i) => i.name)).toEqual(['牛奶', '苹果']);
  });

  it('无到期信息的物品 expiryDate 为 undefined', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [{ name: '盐', quantity: 1 }],
    });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const items = await parser.parse('买了一袋盐');

    expect(items[0]?.expiryDate).toBeUndefined();
    expect(items[0]?.shelfLifeDays).toBeUndefined();
  });

  it('system 提示包含注入的当前日期与星期', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ items: [] });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    await parser.parse('随便说点什么');

    const system = chatTextJson.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('2025-01-01');
    expect(system).toContain('周三');
    // 并校验 user 文本与 temperature=0 透传
    expect(chatTextJson.mock.calls[0]?.[0]?.user).toBe('随便说点什么');
    expect(chatTextJson.mock.calls[0]?.[0]?.temperature).toBe(0);
  });

  it('注入 queue 时经 enqueueImmediate 提交', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      items: [{ name: '牛奶' }],
    });
    // mock 队列：enqueueImmediate 直接执行传入任务的 run
    const enqueueImmediate = vi.fn(
      async <T>(task: { run: () => Promise<T> }): Promise<T> => task.run(),
    );
    const queue = { enqueueImmediate } as unknown as AiQueue;

    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      queue,
      now: () => FIXED_NOW,
    });

    const items = await parser.parse('买了牛奶');

    expect(enqueueImmediate).toHaveBeenCalledTimes(1);
    expect(chatTextJson).toHaveBeenCalledTimes(1);
    expect(items[0]?.name).toBe('牛奶');
  });

  it('模型返回非法结构（items 非数组）抛 bad_response', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ items: '不是数组' });
    const parser = createItemParser({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    await expect(parser.parse('坏数据')).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
    await expect(parser.parse('坏数据')).rejects.toBeInstanceOf(LmStudioError);
  });
});
