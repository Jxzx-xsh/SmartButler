/** 意图分类器单元测试（注入 mock client 与固定时钟，不触网、确定性） */

import { describe, expect, it, vi } from 'vitest';

import { createIntentClassifier } from './intent-classifier.js';
import { LmStudioError } from './errors.js';
import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';

/** 固定时钟：2025-01-01T12:00:00+08:00（周三）。 */
const FIXED_NOW = Date.parse('2025-01-01T12:00:00+08:00');

/** 构造一个只实现 chatTextJson 的 mock client；其余方法置为抛错桩。 */
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

describe('createIntentClassifier.classify', () => {
  it('immediate_action：正确解析 intent 与 action/target 槽位', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      intent: 'immediate_action',
      slots: { action: 'turn_off', target: '客厅灯' },
    });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('把客厅灯关掉');

    expect(result.intent).toBe('immediate_action');
    expect(result.rawText).toBe('把客厅灯关掉');
    expect(result.slots?.action).toBe('turn_off');
    expect(result.slots?.target).toBe('客厅灯');
  });

  it('item_record：正确解析 intent', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ intent: 'item_record', slots: {} });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('我买了两盒牛奶');

    expect(result.intent).toBe('item_record');
  });

  it('query：抽取 queryType=expiring', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({
      intent: 'query',
      slots: { queryType: 'expiring' },
    });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('还有什么快过期了');

    expect(result.intent).toBe('query');
    expect(result.slots?.queryType).toBe('expiring');
  });

  it('unknown：模型返回 unknown 直接透传', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ intent: 'unknown' });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('今天天气怎么样');

    expect(result.intent).toBe('unknown');
  });

  it('非法结构（intent 缺失）→ 兜底 unknown 不抛', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ foo: 'bar' });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('乱七八糟');

    expect(result.intent).toBe('unknown');
    expect(result.rawText).toBe('乱七八糟');
  });

  it('非四枚举 intent → 兜底 unknown', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ intent: '开灯吧' });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('来点光');

    expect(result.intent).toBe('unknown');
  });

  it('chatTextJson 抛错 → 兜底 unknown 不抛', async () => {
    const chatTextJson = vi.fn().mockRejectedValue(new LmStudioError('坏响应', 'bad_response'));
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('随便说点什么');

    expect(result.intent).toBe('unknown');
    expect(result.rawText).toBe('随便说点什么');
  });

  it('system 提示包含注入的当前日期与星期，user/temperature 透传', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ intent: 'unknown' });
    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    await classifier.classify('测试提示');

    const call = chatTextJson.mock.calls[0]?.[0];
    expect(call?.system).toContain('2025-01-01');
    expect(call?.system).toContain('周三');
    expect(call?.user).toBe('测试提示');
    expect(call?.temperature).toBe(0);
  });

  it('注入 queue 时经 enqueueImmediate 提交', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ intent: 'item_record' });
    const enqueueImmediate = vi.fn(
      async <T>(task: { run: () => Promise<T> }): Promise<T> => task.run(),
    );
    const queue = { enqueueImmediate } as unknown as AiQueue;

    const classifier = createIntentClassifier({
      client: makeMockClient(chatTextJson),
      queue,
      now: () => FIXED_NOW,
    });

    const result = await classifier.classify('买了牛奶');

    expect(enqueueImmediate).toHaveBeenCalledTimes(1);
    expect(chatTextJson).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('item_record');
  });
});
