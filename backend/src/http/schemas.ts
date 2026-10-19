/**
 * 集中定义 HTTP 层的 zod 校验 schema。
 *
 * 选用 zod（而非 Fastify JSON Schema）的理由见 task2-plan.md：严格 TS 下
 * 可用 z.infer 得到解析后请求体的精确类型，日期归一化用 .transform() 表达最自然。
 * 校验失败由 app 的统一错误处理转 400。
 */

import { z } from 'zod';

import { zMillisDate } from './date-normalize.js';

/** 来源枚举，与 schema.ts 的 item.source 一致 */
const sourceEnum = z.enum(['manual', 'voice', 'vision']);

/** 布尔查询参数：接受布尔或字符串 "true"/"false" */
const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'true'));

/** POST /api/items 请求体校验 */
export const createItemBodySchema = z.object({
  /** 名称：必填非空（去除首尾空白后不为空） */
  name: z.string().trim().min(1, 'name 不能为空'),
  /** 数量：可选正整数，默认 1 */
  quantity: z.number().int().positive().optional(),
  /** 单位：可空可选（null = 显式清空，undefined/省略 = 不改） */
  unit: z.string().nullable().optional(),
  /** 分类外键：可空可选正整数（null = 显式清空） */
  categoryId: z.number().int().positive().nullable().optional(),
  /** 存放位置：可空可选（null = 显式清空） */
  location: z.string().nullable().optional(),
  /** 购买日期：可空可选，接受 ISO 字符串或毫秒，归一化为毫秒整数（null = 显式清空） */
  purchaseDate: zMillisDate.nullable().optional(),
  /** 保质期天数：可空可选非负整数（null = 显式清空） */
  shelfLifeDays: z.number().int().nonnegative().nullable().optional(),
  /** 到期日期：可空可选，接受 ISO 字符串或毫秒，归一化为毫秒整数（null = 显式清空到期日，不重算） */
  expiryDate: zMillisDate.nullable().optional(),
  /** 是否已确认：可选 */
  confirmed: z.boolean().optional(),
  /** 来源：可选枚举 */
  source: sourceEnum.optional(),
  /** 备注：可空可选（null = 显式清空） */
  note: z.string().nullable().optional(),
});

/** 解析后的创建请求体类型 */
export type CreateItemBody = z.infer<typeof createItemBodySchema>;

/** PATCH /api/items/:id 请求体校验（全部字段可选） */
export const patchItemBodySchema = createItemBodySchema.partial();

/** 解析后的更新请求体类型 */
export type PatchItemBody = z.infer<typeof patchItemBodySchema>;

/** GET /api/items 查询参数校验（query string 均为字符串，需 coerce） */
export const listItemsQuerySchema = z.object({
  /** 分类过滤：可选正整数 */
  categoryId: z.coerce.number().int().positive().optional(),
  /** 位置过滤：可选 */
  location: z.string().optional(),
  /** 确认状态过滤：可选布尔（接受 "true"/"false"） */
  confirmed: booleanQuery.optional(),
});

/** 解析后的列表查询参数类型 */
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;

/** GET /api/items/expiring 查询参数校验：days 默认 3，须为正整数 */
export const expiringQuerySchema = z.object({
  days: z.coerce.number().int().positive().default(3),
});

/** :id 路径参数校验：正整数 */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** POST /api/items/:id/consume 请求体校验：数量与事件类型均可选 */
export const consumeBodySchema = z.object({
  /** 本次消耗数量：可选正整数，默认由仓储取 1 */
  quantity: z.number().int().positive().optional(),
  /** 事件类型：已消耗 / 已丢弃，可选，默认由仓储取 consumed */
  eventType: z.enum(['consumed', 'discarded']).optional(),
});

/** 解析后的消耗请求体类型 */
export type ConsumeBody = z.infer<typeof consumeBodySchema>;

/** GET /api/consumption/history 查询参数校验（query string 均为字符串，需 coerce） */
export const consumptionHistoryQuerySchema = z.object({
  /** 返回条数上限：正整数，最多 200，默认 50 */
  limit: z.coerce.number().int().positive().max(200).default(50),
  /** 物品过滤：可选正整数 */
  itemId: z.coerce.number().int().positive().optional(),
});

/** 解析后的消耗历史查询参数类型 */
export type ConsumptionHistoryQuery = z.infer<
  typeof consumptionHistoryQuerySchema
>;

/** POST /api/categories 请求体校验 */
export const createCategoryBodySchema = z.object({
  /** 分类名称：必填非空 */
  name: z.string().trim().min(1, 'name 不能为空'),
  /** 图标：可选 */
  icon: z.string().optional(),
  /** 颜色：可选 */
  color: z.string().optional(),
});

/** 解析后的创建分类请求体类型 */
export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;

/** POST /api/voice/ingest-text 请求体校验：文本转写内容，必填非空 */
export const ingestTextBodySchema = z.object({
  /** 待解析的转写文本：去除首尾空白后不能为空 */
  text: z.string().trim().min(1, 'text 不能为空'),
});

/** 解析后的文本入库请求体类型 */
export type IngestTextBody = z.infer<typeof ingestTextBodySchema>;

/** POST /api/command 请求体校验：一句中文指令 + 可选来源 */
export const commandBodySchema = z.object({
  /** 指令文本：去除首尾空白后不能为空 */
  text: z.string().trim().min(1, 'text 不能为空'),
  /** 来源：可选，语音或手动（影响 item_record 入库 source 标注） */
  source: z.enum(['voice', 'manual']).optional(),
});

/** 解析后的指令请求体类型 */
export type CommandBody = z.infer<typeof commandBodySchema>;

/** GET /api/recipes/recommend 查询参数校验：days 默认 3，须为正整数 */
export const recipeRecommendQuerySchema = z.object({
  days: z.coerce.number().int().positive().default(3),
});

/** 解析后的食谱推荐查询参数类型 */
export type RecipeRecommendQuery = z.infer<typeof recipeRecommendQuerySchema>;
