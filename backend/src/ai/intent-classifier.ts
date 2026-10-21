/**
 * 意图分类器（Task 11 意图路由主体）。
 *
 * 把一句中文指令（如「把客厅灯关掉」「我买了两盒牛奶」「还有什么快过期了」）通过
 * chatTextJson（qwen/qwen3-4b-2507）分类为四类意图之一：
 * immediate_action（立即执行设备控制）/ item_record（物品记录）/ query（查询）/ unknown。
 *
 * 做法参照 item-parser.ts：在系统提示里注入「当前日期上下文」（基于可注入的 now()），
 * 约束模型只输出严格 JSON，并给出紧凑的四类定义与少量中文示例（Task8 教训：
 * 冗长提示词会让模型返回空/乱，故保持短）。坏输出/非四枚举 intent 一律兜底
 * 返回 { intent:'unknown', rawText }，绝不抛错——指令路由不应因模型抖动而崩。
 *
 * now 可注入固定时钟，保证单测确定性；有 queue 时解析任务经 enqueueImmediate 串行即时提交。
 */

import { z } from 'zod';

import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';
import { buildDateContext } from './date-context.js';

/** 意图类别：立即执行 / 物品记录 / 查询 / 未知。 */
export type Intent = 'immediate_action' | 'item_record' | 'query' | 'unknown';

/**
 * 意图槽位（按 intent 选择性填充）。
 * - immediate_action：action（开/关）、target（设备名）、entityId（显式实体 id）。
 * - query：queryType（目前仅 'expiring' 临期查询）。
 */
export interface IntentSlots {
  /** 立即执行的动作：开 / 关 */
  action?: 'turn_on' | 'turn_off';
  /** 立即执行的目标设备名（模糊名，由路由层匹配 friendly_name） */
  target?: string;
  /** 立即执行的显式实体 id（模型若能给出则优先用） */
  entityId?: string;
  /** 查询类型：临期列表 */
  queryType?: 'expiring';
}

/** 分类结果：intent 恒有，slots 按需，rawText 透传原始指令文本。 */
export interface IntentResult {
  intent: Intent;
  slots?: IntentSlots;
  rawText: string;
}

/** createIntentClassifier 依赖注入入参。 */
export interface CreateIntentClassifierDeps {
  /** LM Studio 客户端，用于 chatTextJson 分类 */
  client: LmStudioClient;
  /** 可选 AI 任务队列：提供时分类任务经 enqueueImmediate 提交（串行、即时优先） */
  queue?: AiQueue;
  /** 当前时间来源，默认 () => Date.now()；测试注入固定时钟保证确定性 */
  now?: () => number;
  /** 意图分类专用模型名，缺省时用 client 默认 textModel */
  model?: string;
}

/** 意图分类器对外句柄。 */
export interface IntentClassifier {
  /** 把一句中文指令分类为 IntentResult */
  classify(text: string): Promise<IntentResult>;
}

/**
 * 构造中文系统提示，注入当前日期上下文。
 *
 * 要求模型只输出严格 JSON { "intent": ..., "slots": {...} }（chatTextJson 用 text
 * 响应格式并对输出做容错 JSON 解析）。提示紧凑：四类定义 + 三个示例，避免冗长。
 */
function buildSystemPrompt(ctx: { date: string; weekday: string }): string {
  return [
    '你是家庭智能管家的指令分类器。把用户的一句中文指令分类为四类意图之一，并抽取槽位。',
    `当前日期：${ctx.date}（${ctx.weekday}），时区按 Asia/Shanghai。`,
    '只输出一个严格 JSON 对象：{"intent":"...","slots":{...}}，不要解释、不要 Markdown 代码块。',
    'intent 取值（四选一）：',
    '- immediate_action：控制设备开关（灯、插座等）。slots 可含 action（"turn_on"|"turn_off"）、target（设备名）。',
    '- item_record：记录新购/入库的物品。',
    '- query：查询信息，目前仅临期物品。slots 可含 queryType（"expiring"）。',
    '- unknown：无法归入以上三类。',
    '示例：',
    '「把客厅灯关掉」→ {"intent":"immediate_action","slots":{"action":"turn_off","target":"客厅灯"}}',
    '「我买了两盒牛奶」→ {"intent":"item_record","slots":{}}',
    '「还有什么快过期了」→ {"intent":"query","slots":{"queryType":"expiring"}}',
  ].join('\n');
}

/** 模型返回槽位的 zod 结构：字段均可选，非预期值在解析时丢弃。 */
const zRawSlots = z
  .object({
    action: z.enum(['turn_on', 'turn_off']).optional().nullable(),
    target: z.string().optional().nullable(),
    entityId: z.string().optional().nullable(),
    queryType: z.literal('expiring').optional().nullable(),
  })
  .optional()
  .nullable();

/** 模型返回整体结构：intent 必须为四枚举之一，否则校验失败兜底 unknown。 */
const zRawResponse = z.object({
  intent: z.enum(['immediate_action', 'item_record', 'query', 'unknown']),
  slots: zRawSlots,
});

/**
 * 创建意图分类器。
 * @param deps 依赖：client（必填）、queue（可选）、now（可选固定时钟）。
 */
export function createIntentClassifier(deps: CreateIntentClassifierDeps): IntentClassifier {
  const { client, queue, model } = deps;
  const now = deps.now ?? ((): number => Date.now());

  async function classify(text: string): Promise<IntentResult> {
    const ctx = buildDateContext(now());
    const system = buildSystemPrompt(ctx);

    // 调用模型：有 queue 时经 enqueueImmediate 串行提交，否则直接调用。
    const callModel = (): Promise<unknown> =>
      client.chatTextJson<unknown>({ system, user: text, temperature: 0, model });

    let raw: unknown;
    try {
      raw = queue
        ? await queue.enqueueImmediate<unknown>({ run: callModel, meta: { kind: 'intent-classify' } })
        : await callModel();
    } catch {
      // 模型调用/解析异常一律兜底 unknown，绝不抛（指令路由不应因此崩）
      return { intent: 'unknown', rawText: text };
    }

    // 校验返回结构；intent 非四枚举或结构非法 → 兜底 unknown
    const parsed = zRawResponse.safeParse(raw);
    if (!parsed.success) {
      return { intent: 'unknown', rawText: text };
    }

    const { intent } = parsed.data;
    const result: IntentResult = { intent, rawText: text };

    // 按 intent 选择性抽取槽位：缺失即省略。
    const rawSlots = parsed.data.slots;
    if (rawSlots !== null && rawSlots !== undefined) {
      const slots: IntentSlots = {};
      if (intent === 'immediate_action') {
        if (rawSlots.action !== null && rawSlots.action !== undefined) {
          slots.action = rawSlots.action;
        }
        if (rawSlots.target !== null && rawSlots.target !== undefined) {
          slots.target = rawSlots.target;
        }
        if (rawSlots.entityId !== null && rawSlots.entityId !== undefined) {
          slots.entityId = rawSlots.entityId;
        }
      } else if (intent === 'query') {
        if (rawSlots.queryType !== null && rawSlots.queryType !== undefined) {
          slots.queryType = rawSlots.queryType;
        }
      }
      // 仅在确有槽位时附加 slots
      if (Object.keys(slots).length > 0) {
        result.slots = slots;
      }
    }

    return result;
  }

  return { classify };
}
