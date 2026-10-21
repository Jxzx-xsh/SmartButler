/**
 * 收藏食谱数据访问层。
 *
 * 函数式、以参数接收 drizzle 实例（AppDatabase），便于测试注入内存库。
 * usedItems / missingItems / steps 在库中以 JSON 文本存储（见 schema.savedRecipes），
 * 本层负责写入时 JSON.stringify、读出时 JSON.parse，对外暴露真正的字符串数组。
 * 去重策略：允许重复收藏，saveRecipe 每次 INSERT 新行。
 */

import { desc, eq } from 'drizzle-orm';

import type { AppDatabase } from './client.js';
import { savedRecipes, type SavedRecipe } from './schema.js';

/** 对外领域视图：数组字段已反序列化为真正的 string[] */
export interface SavedRecipeView {
  id: number;
  name: string;
  usedItems: string[];
  missingItems: string[] | null;
  steps: string[] | null;
  note: string | null;
  createdAt: number;
}

/** saveRecipe 的输入类型：仅 name 必填，其余可选 */
export interface SaveRecipeInput {
  name: string;
  usedItems?: string[];
  missingItems?: string[] | null;
  steps?: string[] | null;
  note?: string | null;
}

/** 把数据库行（JSON 文本列）反序列化为对外领域视图 */
function toView(row: SavedRecipe): SavedRecipeView {
  return {
    id: row.id,
    name: row.name,
    usedItems: JSON.parse(row.usedItems) as string[],
    missingItems:
      row.missingItems === null
        ? null
        : (JSON.parse(row.missingItems) as string[]),
    steps: row.steps === null ? null : (JSON.parse(row.steps) as string[]),
    note: row.note,
    createdAt: row.createdAt,
  };
}

/**
 * 收藏一条食谱（允许重复，每次 INSERT 新行）。
 * usedItems 缺省为 []；missingItems/steps 为 null 或缺省时存 null，否则存 JSON 文本；
 * note 原样直存。返回反序列化后的领域视图。
 */
export function saveRecipe(
  db: AppDatabase,
  input: SaveRecipeInput,
): SavedRecipeView {
  const rows = db
    .insert(savedRecipes)
    .values({
      name: input.name,
      usedItems: JSON.stringify(input.usedItems ?? []),
      missingItems:
        input.missingItems == null ? null : JSON.stringify(input.missingItems),
      steps: input.steps == null ? null : JSON.stringify(input.steps),
      note: input.note ?? null,
    })
    .returning()
    .all();
  const created = rows[0];
  if (created === undefined) {
    throw new Error('saveRecipe 未返回插入结果');
  }
  return toView(created);
}

/** 列出全部收藏食谱，按收藏时间倒序（同刻按 id 倒序兜底稳定） */
export function listSavedRecipes(db: AppDatabase): SavedRecipeView[] {
  const rows = db
    .select()
    .from(savedRecipes)
    .orderBy(desc(savedRecipes.createdAt), desc(savedRecipes.id))
    .all();
  return rows.map(toView);
}

/** 删除一条收藏，返回是否删除成功（不存在返回 false） */
export function removeSavedRecipe(db: AppDatabase, id: number): boolean {
  const rows = db
    .delete(savedRecipes)
    .where(eq(savedRecipes.id, id))
    .returning()
    .all();
  return rows.length > 0;
}
