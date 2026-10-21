/**
 * 食谱推荐器（功能② 核心价值）。
 *
 * 基于家里现有食材（临期优先）让本地 qwen3-4b 推荐 2-4 道家常易做菜。
 * 镜像 ai/item-parser.ts 范式：依赖注入 client/queue/now + buildDateContext +
 * chatTextJson 容错解析 + zod 校验 + queue.enqueueImmediate 串行提交。
 *
 * 取材来源：先 listExpiringItems 得临期项（标注「优先用掉」），再 listItems
 * 取已确认食品，合并去重（临期在前），拼进紧凑中文系统提示交模型推荐。
 * 提示刻意精简（任务前置、优先临期、2-4 道家常菜、严格 JSON、仅给 1 个示例），
 * 吸取冗长提示致模型输出空结果的教训。
 */

import { z } from 'zod';

import type { AppDatabase } from '../db/client.js';
import type { LmStudioClient } from './lmstudio.js';
import type { AiQueue } from './queue.js';
import { LmStudioError } from './errors.js';
import { buildDateContext } from './date-context.js';
import { listExpiringItems, listItems } from '../db/repository.js';

/** 单道推荐菜谱。 */
export interface Recipe {
  /** 菜名 */
  name: string;
  /** 用到的家里现有食材名 */
  usedItems: string[];
  /** 还缺少、需另购的食材名（可选） */
  missingItems?: string[];
  /** 简要做法步骤（可选） */
  steps?: string[];
  /** 备注，如口味/份量提示（可选） */
  note?: string;
}

/** 食谱推荐结果。 */
export interface RecipeResult {
  /** 模型写在 JSON 里的推荐理由摘要（可能为空） */
  thinking?: string;
  /** 模型的原始思维链（qwen3 reasoning_content，可能为空） */
  reasoning?: string;
  recipes: Recipe[];
}

/** recommend 的可选参数。 */
export interface RecommendOptions {
  /** 临期判定天数，默认 3 */
  days?: number;
}

/** createRecipeRecommender 依赖注入入参。 */
export interface CreateRecipeRecommenderDeps {
  /** LM Studio 客户端，用于 chatTextJson 推荐 */
  client: LmStudioClient;
  /** 可选 AI 任务队列：提供时推荐任务经 enqueueImmediate 提交（串行、即时优先） */
  queue?: AiQueue;
  /** 当前时间来源，默认 () => Date.now()；测试注入固定时钟保证确定性 */
  now?: () => number;
  /** 菜谱推荐专用模型名，缺省时用 client 默认 textModel */
  model?: string;
}

/** 食谱推荐器对外句柄。 */
export interface RecipeRecommender {
  /** 基于家里食材推荐 2-4 道家常菜 */
  recommend(db: AppDatabase, opts?: RecommendOptions): Promise<RecipeResult>;
}

/** 构造取材清单的单项：名称 + 是否临期（优先用掉）。 */
interface PantryEntry {
  name: string;
  expiring: boolean;
}

/**
 * 合并临期项与已确认食品，去重（按名称），临期在前。
 * 临期项标注 expiring=true；已确认项中与临期同名的跳过（已在前）。
 */
function buildPantry(expiring: string[], confirmed: string[]): PantryEntry[] {
  const seen = new Set<string>();
  const pantry: PantryEntry[] = [];
  for (const name of expiring) {
    if (name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    pantry.push({ name, expiring: true });
  }
  for (const name of confirmed) {
    if (name === '' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    pantry.push({ name, expiring: false });
  }
  return pantry;
}

/**
 * 构造紧凑中文系统提示。
 *
 * 要点（刻意精简，避免冗长致空）：任务前置、临期食材优先用掉、只推 2-4 道
 * 家常易做菜、严格 JSON 无 markdown、给 1 个示例。食材清单内联在提示里，
 * 临期项显式标注「优先用掉」。
 */
function buildSystemPrompt(
  ctx: { date: string; weekday: string },
  pantry: PantryEntry[],
): string {
  // 食材清单文本：临期项标注「（优先用掉）」
  const pantryText = pantry
    .map((e) => (e.expiring ? `${e.name}（优先用掉）` : e.name))
    .join('、');

  return [
    '你是家庭做菜助手。根据下面家里现有的食材，推荐 2-4 道家常、好做的菜。',
    `当前日期：${ctx.date}（${ctx.weekday}）。`,
    `家里现有食材：${pantryText || '（无）'}`,
    '要求：优先用掉标注「优先用掉」的临期食材；每道菜尽量用现有食材，缺的食材列进 missingItems；只推家常易做的菜，共 2-4 道。',
    '先写一段简短的思考过程（thinking 字段），说清你优先用了哪些临期食材、为什么选这些菜；再输出菜谱。',
    '只输出严格 JSON，不要 markdown、不要多余解释。格式：',
    '{"thinking":"你的推荐理由","recipes":[{"name":"菜名","usedItems":["用到的现有食材"],"missingItems":["需另购食材"],"steps":["简要步骤"],"note":"备注"}]}',
    '示例：{"thinking":"家里鸡蛋和番茄都临期了，先做番茄炒蛋快速消耗；剩下的黄瓜凉拌清爽","recipes":[{"name":"番茄炒蛋","usedItems":["番茄","鸡蛋"],"missingItems":["葱"],"steps":["鸡蛋打散炒熟盛出","番茄翻炒出汁","倒入鸡蛋加盐翻匀"],"note":"家常快手菜"}]}',
  ].join('\n');
}

/** 模型返回单道菜谱的 zod 结构：name 必填，其余可选。 */
const zRawRecipe = z.object({
  name: z.string(),
  usedItems: z.array(z.string()).optional().nullable(),
  missingItems: z.array(z.string()).optional().nullable(),
  steps: z.array(z.string()).optional().nullable(),
  note: z.string().optional().nullable(),
});

/** 模型返回整体结构：{ thinking?, recipes: RawRecipe[] }。 */
const zRawResponse = z.object({
  thinking: z.string().optional().nullable(),
  recipes: z.array(zRawRecipe),
});

/**
 * 创建食谱推荐器。
 * @param deps 依赖：client（必填）、queue（可选）、now（可选固定时钟）。
 */
export function createRecipeRecommender(
  deps: CreateRecipeRecommenderDeps,
): RecipeRecommender {
  const { client, model } = deps;
  const now = deps.now ?? ((): number => Date.now());

  async function recommend(
    db: AppDatabase,
    opts: RecommendOptions = {},
  ): Promise<RecipeResult> {
    const days = opts.days ?? 3;

    // 临期项（含已过期）：标注优先用掉，排在取材清单前列
    const expiringNames = listExpiringItems(db, days, now()).map((i) => i.name);
    // 已确认食品：补充非临期的可用食材
    const confirmedNames = listItems(db, { confirmed: true }).map((i) => i.name);
    const pantry = buildPantry(expiringNames, confirmedNames);

    const ctx = buildDateContext(now());
    const system = buildSystemPrompt(ctx, pantry);
    const user = '请根据以上食材推荐家常菜。';

    // 调用模型：recipe 不走 queue（queue 里 deferred 的 vision-parser 可能占着 worker
    // 导致 immediate 被延迟执行、模型超时返回空）。直接调用即可。
    // 用 chatTextJsonWithReasoning 顺带拿回 qwen3 原始思维链，供前端展示。
    const { data: raw, reasoning } = await client.chatTextJsonWithReasoning<unknown>({
      system,
      user,
      temperature: 0,
      model,
    });

    // 校验模型返回结构；非法（recipes 非数组等）抛 bad_response
    const parsed = zRawResponse.safeParse(raw);
    if (!parsed.success) {
      throw new LmStudioError('食谱推荐返回的 JSON 结构非法', 'bad_response', parsed.error);
    }

    const recipes: Recipe[] = [];
    for (const rawRecipe of parsed.data.recipes) {
      const name = rawRecipe.name.trim();
      // 菜名缺失/空白判为该条无效，丢弃
      if (name === '') {
        continue;
      }

      const recipe: Recipe = {
        name,
        usedItems: (rawRecipe.usedItems ?? []).map((s) => s.trim()).filter((s) => s !== ''),
      };
      const missingItems = (rawRecipe.missingItems ?? [])
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (missingItems.length > 0) {
        recipe.missingItems = missingItems;
      }
      const steps = (rawRecipe.steps ?? []).map((s) => s.trim()).filter((s) => s !== '');
      if (steps.length > 0) {
        recipe.steps = steps;
      }
      if (rawRecipe.note !== null && rawRecipe.note !== undefined) {
        const note = rawRecipe.note.trim();
        if (note !== '') {
          recipe.note = note;
        }
      }

      recipes.push(recipe);
    }

    const thinking =
      parsed.data.thinking !== null && parsed.data.thinking !== undefined
        ? parsed.data.thinking.trim() || undefined
        : undefined;

    const result: RecipeResult = { recipes };
    if (thinking) {
      result.thinking = thinking;
    }
    if (reasoning) {
      result.reasoning = reasoning;
    }
    return result;
  }

  return { recommend };
}
