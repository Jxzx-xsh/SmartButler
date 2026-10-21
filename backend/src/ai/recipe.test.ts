/** 食谱推荐器单元测试（注入 fake client + 内存库 + 固定时钟，不触网、确定性） */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRecipeRecommender } from './recipe.js';
import { LmStudioError } from './errors.js';
import type { LmStudioClient } from './lmstudio.js';
import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';

/** 固定时钟：2025-01-01T12:00:00+08:00（周三）。 */
const FIXED_NOW = Date.parse('2025-01-01T12:00:00+08:00');
/** 一天毫秒。 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 构造一个只实现 chatTextJsonWithReasoning 的 fake client；其余方法用不到，置为抛错桩。 */
function makeFakeClient(
  chatTextJsonWithReasoning: ReturnType<typeof vi.fn>,
): LmStudioClient {
  const notUsed = (): never => {
    throw new Error('本测试不应调用该方法');
  };
  return {
    chatText: notUsed,
    chatTextJson: notUsed,
    chatTextJsonWithReasoning,
    chatVision: notUsed,
    chatVisionJson: notUsed,
    embed: notUsed,
    listModels: notUsed,
  } as unknown as LmStudioClient;
}

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRecipeRecommender.recommend', () => {
  it('fake 返回合法 JSON → 解析出 recipes', async () => {
    // 临期：牛奶（1 天后到期）；已确认非临期：鸡蛋
    createItem(db, { name: '牛奶', expiryDate: FIXED_NOW + MS_PER_DAY });
    createItem(db, { name: '鸡蛋' });

    const chatTextJson = vi.fn().mockResolvedValue({
      data: {
        recipes: [
          {
            name: '牛奶炖蛋',
            usedItems: ['牛奶', '鸡蛋'],
            missingItems: ['糖'],
            steps: ['牛奶加热', '打入鸡蛋搅匀', '上锅蒸'],
            note: '家常甜品',
          },
        ],
      },
    });
    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await recommender.recommend(db);

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      name: '牛奶炖蛋',
      usedItems: ['牛奶', '鸡蛋'],
      missingItems: ['糖'],
      note: '家常甜品',
    });
    expect(result.recipes[0]?.steps).toHaveLength(3);
  });

  it('系统提示包含临期物品名且标注优先使用、含严格 JSON 要求与 1 个示例', async () => {
    // 牛奶临期，面粉已确认非临期
    createItem(db, { name: '牛奶', expiryDate: FIXED_NOW + MS_PER_DAY });
    createItem(db, { name: '面粉' });

    const chatTextJson = vi.fn().mockResolvedValue({ data: { recipes: [] } });
    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    await recommender.recommend(db);

    const system = chatTextJson.mock.calls[0]?.[0]?.system as string;
    // 临期物品名出现且标注「优先用掉」
    expect(system).toContain('牛奶（优先用掉）');
    // 非临期物品也在清单中
    expect(system).toContain('面粉');
    // 优先使用临期食材的要求
    expect(system).toContain('优先');
    // 严格 JSON 要求
    expect(system).toContain('JSON');
    // 含 1 个示例
    expect(system).toContain('示例');
    expect(system).toContain('番茄炒蛋');
    // temperature=0 透传
    expect(chatTextJson.mock.calls[0]?.[0]?.temperature).toBe(0);
  });

  it('fake 返回结构非法（recipes 非数组）→ 抛 bad_response', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ data: { recipes: '不是数组' } });
    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    await expect(recommender.recommend(db)).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
    await expect(recommender.recommend(db)).rejects.toBeInstanceOf(LmStudioError);
  });

  it('空库不崩：无食材也能正常返回', async () => {
    const chatTextJson = vi.fn().mockResolvedValue({ data: { recipes: [] } });
    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    const result = await recommender.recommend(db);

    expect(result.recipes).toEqual([]);
    // 空库时提示里食材清单为「（无）」
    const system = chatTextJson.mock.calls[0]?.[0]?.system as string;
    expect(system).toContain('（无）');
  });

  it('days 参数透传给 listExpiringItems（影响临期标注窗口）', async () => {
    // 牛奶 5 天后到期：days=3 时不算临期，days=7 时算临期
    createItem(db, { name: '牛奶', expiryDate: FIXED_NOW + 5 * MS_PER_DAY, confirmed: true });

    const chatTextJson = vi.fn().mockResolvedValue({ data: { recipes: [] } });
    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      now: () => FIXED_NOW,
    });

    // days=3：牛奶不在临期窗口，清单里不应标注「优先用掉」
    await recommender.recommend(db, { days: 3 });
    const systemDays3 = chatTextJson.mock.calls[0]?.[0]?.system as string;
    expect(systemDays3).toContain('牛奶');
    expect(systemDays3).not.toContain('牛奶（优先用掉）');

    // days=7：牛奶进入临期窗口，应标注「优先用掉」
    await recommender.recommend(db, { days: 7 });
    const systemDays7 = chatTextJson.mock.calls[1]?.[0]?.system as string;
    expect(systemDays7).toContain('牛奶（优先用掉）');
  });

  it('模型思维链 reasoning 透传到结果；无思维链时缺省', async () => {
    createItem(db, { name: '牛奶', expiryDate: FIXED_NOW + MS_PER_DAY });

    // 有 reasoning_content：透传
    const withReasoning = vi.fn().mockResolvedValue({
      data: { recipes: [{ name: '牛奶炖蛋', usedItems: ['牛奶'] }] },
      reasoning: '好的，用户想让我推荐菜，先看食材。牛奶临期了，优先用掉……',
    });
    const r1 = await createRecipeRecommender({
      client: makeFakeClient(withReasoning),
      now: () => FIXED_NOW,
    }).recommend(db);
    expect(r1.reasoning).toContain('牛奶临期了');

    // 无 reasoning_content：结果不带 reasoning 键
    const withoutReasoning = vi.fn().mockResolvedValue({
      data: { recipes: [{ name: '牛奶炖蛋', usedItems: ['牛奶'] }] },
    });
    const r2 = await createRecipeRecommender({
      client: makeFakeClient(withoutReasoning),
      now: () => FIXED_NOW,
    }).recommend(db);
    expect(r2.reasoning).toBeUndefined();
  });

  it('注入 queue 时仍直接调用模型（绕开 queue，避免被 deferred 任务阻塞）', async () => {
    createItem(db, { name: '牛奶', expiryDate: FIXED_NOW + MS_PER_DAY });
    const chatTextJson = vi.fn().mockResolvedValue({
      data: { recipes: [{ name: '牛奶炖蛋', usedItems: ['牛奶'] }] },
    });
    // fake 队列：若被调用则直接执行；本测试断言它不会被调用
    const enqueueImmediate = vi.fn(
      async <T>(task: { run: () => Promise<T> }): Promise<T> => task.run(),
    );
    const queue = { enqueueImmediate } as unknown as import('./queue.js').AiQueue;

    const recommender = createRecipeRecommender({
      client: makeFakeClient(chatTextJson),
      queue,
      now: () => FIXED_NOW,
    });

    const result = await recommender.recommend(db);

    // queue 中 deferred 的 vision-parser 可能占住 worker 导致 immediate 超时，
    // recipe 不走 queue，直接调用模型
    expect(enqueueImmediate).not.toHaveBeenCalled();
    expect(chatTextJson).toHaveBeenCalledTimes(1);
    expect(result.recipes[0]?.name).toBe('牛奶炖蛋');
  });
});
