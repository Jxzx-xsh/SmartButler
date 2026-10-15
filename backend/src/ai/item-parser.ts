/**
 * 物品解析器（Task 5 核心价值）。
 *
 * 把一句中文口语转写文本（如「我买了两盒牛奶，保质期到下周五」）通过
 * chatTextJson（qwen/qwen3-4b-2507）解析为结构化物品数组 ParsedItem[]。
 *
 * 重点在中文相对/模糊日期的稳定解析：『下周五』『三天后』『保质期一周』。
 * 做法是在系统提示里注入「当前日期上下文」（基于可注入的 now()，用
 * Asia/Shanghai 语义给出今天的 YYYY-MM-DD 与星期几），让模型据此把相对日期
 * 换算为【绝对到期日 ISO 字符串】，再在本模块用 normalizeToMillis 归一化为
 * Unix 毫秒整数。now 可注入固定时钟，保证单测确定性。
 *
 * 本模块不依赖数据库：category 保留为「分类名字符串」，由路由层映射到已有分类 id。
 */

import { z } from 'zod';

import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';
import { LmStudioError } from './errors.js';
import { buildDateContext } from './date-context.js';
import { normalizeToMillis } from '../http/date-normalize.js';

/**
 * 解析出的单个物品。
 *
 * 字段对应仓储 CreateItemInput 的可解析部分；category 为【分类名字符串】
 * （路由层再映射到已有分类 id）；所有日期为 Unix 毫秒整数。
 */
export interface ParsedItem {
  /** 物品名称（必填，缺失/空白的条目会被丢弃） */
  name: string;
  /** 数量（整数） */
  quantity?: number;
  /** 单位，如「盒」「袋」 */
  unit?: string | null;
  /** 分类名（非 id），由路由层映射到已有分类 */
  category?: string | null;
  /** 存放位置，如「冰箱冷藏」 */
  location?: string | null;
  /** 购买日期（Unix 毫秒整数） */
  purchaseDate?: number | null;
  /** 保质期天数（无法确定绝对到期日时由模型返回） */
  shelfLifeDays?: number | null;
  /** 到期日期（Unix 毫秒整数） */
  expiryDate?: number | null;
}

/** createItemParser 依赖注入入参。 */
export interface CreateItemParserDeps {
  /** LM Studio 客户端，用于 chatTextJson 解析 */
  client: LmStudioClient;
  /** 可选 AI 任务队列：提供时解析任务经 enqueueImmediate 提交（串行、即时优先） */
  queue?: AiQueue;
  /** 当前时间来源，默认 () => Date.now()；测试注入固定时钟保证确定性 */
  now?: () => number;
}

/** 物品解析器对外句柄。 */
export interface ItemParser {
  /** 解析一句转写文本为结构化物品数组 */
  parse(text: string): Promise<ParsedItem[]>;
}

/**
 * 构造中文系统提示，注入当前日期上下文。
 *
 * 要求模型只输出严格 JSON 对象 { items: [...] }（chatTextJson 用 text 响应格式
 * 并对输出做容错 JSON 解析），并把中文相对/模糊日期换算为绝对到期日 ISO 字符串。
 */
function buildSystemPrompt(ctx: { date: string; weekday: string }): string {
  return [
    '你是一个家庭物品录入助手。请把用户的一句中文口语转写文本解析为结构化的物品清单。',
    '',
    `当前日期：${ctx.date}（${ctx.weekday}），时区按 Asia/Shanghai 理解。`,
    '',
    '只输出一个严格的 JSON 对象，格式为：{ "items": [ { ... }, ... ] }，不要输出任何解释、不要用 Markdown 代码块。',
    '',
    '每个物品对象可包含以下字段（除 name 外均可省略）：',
    '- name：物品名称（必填，字符串）。',
    '- quantity：数量（整数）。',
    '- unit：单位（字符串，如「盒」「袋」「瓶」）。',
    '- category：分类名（字符串，如「乳制品」「蔬菜」「日用品」）。',
    '- location：存放位置（字符串，如「冰箱冷藏」「橱柜」）。',
    '- expiryDate：到期日期，务必输出【绝对日期的 ISO 8601 字符串】，如 "2025-01-10"。',
    '- shelfLifeDays：保质期天数（整数）。仅当无法确定绝对到期日（例如用户只说了保质期而没有购买日）时才用它。',
    '- purchaseDate：购买日期的 ISO 8601 字符串（如用户明确提及）。',
    '',
    '关键——中文相对/模糊日期必须换算为绝对日期：',
    '- 以上面的「当前日期」为基准进行推算。',
    '- 「下周五」：指下一个将要到来的周五；若今天已经过了本周的周五（即今天是周六或周日），则取再下一周的周五。换言之，取严格晚于今天的最近一个周五，且当今天就是周五时取下一个周五。',
    '- 「三天后」「一周后」等：在当前日期上加对应天数，得到绝对日期。',
    '- 「保质期一周」「保质期到下周五」：若能确定绝对到期日则填 expiryDate；否则填 shelfLifeDays。',
    '- 所有日期一律用 ISO 8601 字符串（优先 YYYY-MM-DD）。',
    '',
    '若一句话包含多个物品，请在 items 数组中分别列出。无法识别出任何物品时返回 { "items": [] }。',
  ].join('\n');
}

/** 模型返回单个物品的 zod 结构：name 必填，其余可选。 */
const zRawItem = z.object({
  name: z.string(),
  quantity: z.number().optional().nullable(),
  unit: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  // 日期允许 ISO 字符串或毫秒整数，稍后用 normalizeToMillis 归一化
  purchaseDate: z.union([z.string(), z.number()]).optional().nullable(),
  shelfLifeDays: z.number().optional().nullable(),
  expiryDate: z.union([z.string(), z.number()]).optional().nullable(),
});

/** 模型返回整体结构：{ items: RawItem[] }。 */
const zRawResponse = z.object({
  items: z.array(zRawItem),
});

/** 把可空的日期原始值归一化为毫秒整数；为空返回 undefined，非法抛 bad_response。 */
function normalizeDate(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  try {
    return normalizeToMillis(value);
  } catch (err) {
    throw new LmStudioError('物品解析返回的日期无法归一化', 'bad_response', err);
  }
}

/**
 * 创建物品解析器。
 * @param deps 依赖：client（必填）、queue（可选）、now（可选固定时钟）。
 */
export function createItemParser(deps: CreateItemParserDeps): ItemParser {
  const { client, queue } = deps;
  const now = deps.now ?? ((): number => Date.now());

  async function parse(text: string): Promise<ParsedItem[]> {
    const ctx = buildDateContext(now());
    const system = buildSystemPrompt(ctx);

    // 调用模型：有 queue 时经 enqueueImmediate 串行提交，否则直接调用
    const callModel = (): Promise<unknown> =>
      client.chatTextJson<unknown>({ system, user: text, temperature: 0 });
    const raw = queue
      ? await queue.enqueueImmediate<unknown>({ run: callModel, meta: { kind: 'item-parse' } })
      : await callModel();

    // 校验模型返回结构；非法（items 非数组等）抛 bad_response
    const parsed = zRawResponse.safeParse(raw);
    if (!parsed.success) {
      throw new LmStudioError('物品解析返回的 JSON 结构非法', 'bad_response', parsed.error);
    }

    const items: ParsedItem[] = [];
    for (const rawItem of parsed.data.items) {
      // name 缺失或空白的条目判为该条解析失败，丢弃
      const name = rawItem.name.trim();
      if (name === '') {
        continue;
      }

      const item: ParsedItem = { name };
      if (rawItem.quantity !== null && rawItem.quantity !== undefined) {
        item.quantity = rawItem.quantity;
      }
      if (rawItem.unit !== null && rawItem.unit !== undefined) {
        item.unit = rawItem.unit;
      }
      if (rawItem.category !== null && rawItem.category !== undefined) {
        item.category = rawItem.category;
      }
      if (rawItem.location !== null && rawItem.location !== undefined) {
        item.location = rawItem.location;
      }
      if (rawItem.shelfLifeDays !== null && rawItem.shelfLifeDays !== undefined) {
        item.shelfLifeDays = rawItem.shelfLifeDays;
      }
      const purchaseDate = normalizeDate(rawItem.purchaseDate);
      if (purchaseDate !== undefined) {
        item.purchaseDate = purchaseDate;
      }
      const expiryDate = normalizeDate(rawItem.expiryDate);
      if (expiryDate !== undefined) {
        item.expiryDate = expiryDate;
      }

      items.push(item);
    }

    return items;
  }

  return { parse };
}
