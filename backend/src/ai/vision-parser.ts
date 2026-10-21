/**
 * 视觉物品识别器（Task 8 核心价值）。
 *
 * 把一帧 JPEG 画面通过 chatVisionJson（qwen/qwen3-vl-8b）识别为结构化物品数组
 * ParsedItem[]（与 item-parser 同构）。做法：把 JPEG 转 base64 data URL 发给
 * 视觉模型，并在系统提示里注入「当前日期上下文」（基于可注入的 now()，用
 * Asia/Shanghai 语义给出今天的 YYYY-MM-DD 与星期几），让模型把画面中的中文
 * 到期线索换算为【绝对到期日 ISO 字符串】，再在本模块用 normalizeToMillis
 * 归一化为 Unix 毫秒整数。
 *
 * 与 item-parser 一致：category 保留为「分类名字符串」（路由层映射到分类 id）；
 * name 缺失/空白的条目丢弃；识别不出返回 []。有 queue 时解析任务走
 * enqueueDeferred（视觉分析属延后批处理），缺省则直接调用。
 *
 * 本模块不碰入库/路由/接线（见 FEAT-002）。
 */

import { z } from 'zod';

import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';
import type { ParsedItem } from './item-parser.js';
import { LmStudioError } from './errors.js';
import { buildDateContext } from './date-context.js';
import { normalizeToMillis } from '../http/date-normalize.js';

/** createVisionParser 依赖注入入参。 */
export interface CreateVisionParserDeps {
  /** LM Studio 客户端，用于 chatVisionJson 识别 */
  client: LmStudioClient;
  /** 可选 AI 任务队列：提供时识别任务经 enqueueDeferred 提交（延后、空闲批处理） */
  queue?: AiQueue;
  /** 可选固定时钟，默认 () => Date.now()；测试注入保证确定性 */
  now?: () => number;
  /** 视觉识别专用模型名，缺省时用 client 默认 visionModel */
  model?: string;
}

/** 视觉物品识别器对外句柄。 */
export interface VisionParser {
  /** 识别一帧 JPEG 画面为结构化物品数组 */
  parseFrame(jpeg: Buffer, timestamp: number): Promise<ParsedItem[]>;
}

/**
 * 构造中文系统提示，注入当前日期上下文。
 *
 * 要求模型只输出严格 JSON 对象 { items: [...] }（chatVisionJson 对输出做容错
 * JSON 解析），并把画面中的中文相对/模糊到期线索换算为绝对到期日 ISO 字符串。
 */
function buildSystemPrompt(ctx: { date: string; weekday: string }): string {
  // 说明：提示词采用「识别任务前置、措辞紧凑」的结构。实测 qwen3-vl-8b 在过长/
  // 过多前置约束的提示词下会直接返回 {"items":[]}（空识别）；把识别任务放在最前、
  // 收紧措辞后模型能稳定返回物品。本提示词完整保留以下产品语义不变：
  //   - 识别范围：画面中的实物 + 画面中可见的物品名称文字（包装/标签/小票/清单）；
  //   - 日期换算能力：把中文相对/模糊日期按「当前日期」换算为绝对 ISO 日期；
  //   - 字段集合：name/quantity/unit/category/location/expiryDate/shelfLifeDays/purchaseDate。
  return [
    '你是一个家庭物品识别助手。识别图片中出现的食材、食品与日用品，解析为结构化的物品清单。',
    '识别来源既包括画面中的【实物】（如冰箱里的牛奶盒、桌上的水果），也包括画面中清晰可见的【物品名称文字】——例如包装/标签上印的品名、购物小票或清单上列出的物品。只要能从画面中确定一件家庭物品就列入；不要因为"只是文字而非实物"而忽略它。',
    '只输出一个严格的 JSON 对象：{ "items": [ { ... }, ... ] }，不要输出任何解释、不要用 Markdown 代码块。无法识别出任何物品时返回 { "items": [] }。',
    '每个物品对象字段（除 name 外均可省略）：name（物品名称，必填，字符串）、quantity（数量，整数）、unit（单位，字符串，如「盒」「袋」「瓶」）、category（分类名，字符串，如「乳制品」「蔬菜」「日用品」）、location（存放位置，字符串，如「冰箱冷藏」「橱柜」）、expiryDate（到期日期，绝对 ISO 8601 字符串，如 "2025-01-10"）、shelfLifeDays（保质期天数，整数；仅当无法确定绝对到期日时才用）、purchaseDate（购买日期的 ISO 8601 字符串，画面上明确可见时填）。',
    `当前日期：${ctx.date}（${ctx.weekday}），时区按 Asia/Shanghai 理解。画面中的中文相对/模糊日期必须以「当前日期」为基准换算为绝对日期（「三天后」「一周后」即加对应天数）；能确定绝对到期日填 expiryDate，否则填 shelfLifeDays；所有日期一律用 ISO 8601 字符串（优先 YYYY-MM-DD）。`,
  ].join('\n');
}

/**
 * 数量容错：接受 number 或可转数字的字符串，归一化为整数；
 * 无法转换（NaN、空串、非数字文本如「两盒」）时产出 undefined（即「忽略该字段」），
 * 而不是让整条 item 校验失败。null/缺省同样产出 undefined。
 *
 * 为什么用 preprocess 做字段级降级而非 union(...).catch(...)：
 *   任务要求「无法转则忽略该字段而非整条失败」，preprocess 能把容错局部化到
 *   单个字段，不影响同条 item 的其它字段与整体 { items: [...] } 结构校验。
 */
const zQuantity = z.preprocess((v) => {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? Math.trunc(v) : undefined;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') {
      return undefined;
    }
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  // 其它类型（对象、数组等）一律忽略该字段
  return undefined;
}, z.number().int().optional());

/** 模型返回单个物品的 zod 结构：name 必填，其余可选（与 item-parser 同构）。 */
const zRawItem = z.object({
  name: z.string(),
  quantity: zQuantity,
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
    throw new LmStudioError('视觉识别返回的日期无法归一化', 'bad_response', err);
  }
}

/**
 * 创建视觉物品识别器。
 * @param deps 依赖：client（必填）、queue（可选）、now（可选固定时钟）。
 */
export function createVisionParser(deps: CreateVisionParserDeps): VisionParser {
  const { client, queue, model } = deps;
  const now = deps.now ?? ((): number => Date.now());

  async function parseFrame(jpeg: Buffer, timestamp: number): Promise<ParsedItem[]> {
    const ctx = buildDateContext(now());
    const system = buildSystemPrompt(ctx);
    // 用户侧简短指令，附带帧时间戳语境（仅供模型参考，不参与日期换算）
    const user = `请识别这张家庭场景图片中的物品（画面时间戳：${timestamp}）。`;
    // JPEG → base64 data URL
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

    // chatVision 只接收单个 prompt 字符串，故把 system 与 user 合并
    const run = (): Promise<unknown> =>
      client.chatVisionJson<unknown>({
        model,
        prompt: `${system}\n${user}`,
        images: [dataUrl],
        temperature: 0,
      });

    // 有 queue 时识别任务走 enqueueDeferred（延后批处理），缺省直接调用
    const raw = queue
      ? await queue.enqueueDeferred<unknown>({ run, meta: { kind: 'vision-parse' } })
      : await run();

    // 校验模型返回结构；非法（items 非数组等）抛 bad_response
    const parsed = zRawResponse.safeParse(raw);
    if (!parsed.success) {
      throw new LmStudioError('视觉识别返回的 JSON 结构非法', 'bad_response', parsed.error);
    }

    const items: ParsedItem[] = [];
    for (const rawItem of parsed.data.items) {
      // name 缺失或空白的条目判为该条识别失败，丢弃
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

  return { parseFrame };
}
