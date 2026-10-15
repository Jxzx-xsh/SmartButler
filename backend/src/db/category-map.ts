/**
 * 分类名 → 分类 id 映射（共享）。
 *
 * 从 voice.ts 抽出的共享逻辑：把模型返回的「分类名字符串」宽松匹配到已有分类 id
 * （大小写不敏感、去首尾空白），匹配不到不自动建分类。供语音/视觉入库复用。
 *
 * 实现与原 voice.ts 内私有 categoryKey 及内联建 map 的循环逐字等价（行为不变）。
 */

import type { AppDatabase } from './client.js';
import { listCategories } from './repository.js';

/**
 * 把分类名归一化为用于匹配的 key：去首尾空白 + 转小写。
 * 用于把模型返回的分类名宽松匹配到已有分类（大小写不敏感）。
 */
export function categoryKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 遍历 listCategories(db) 建「分类名 key → id」映射（大小写不敏感、去空白）。
 * 调用方据此把模型返回的 category 名映射到已有分类 id；匹配不到则不设（不建新分类）。
 */
export function buildCategoryIdMap(db: AppDatabase): Map<string, number> {
  const categoryIdByKey = new Map<string, number>();
  for (const cat of listCategories(db)) {
    categoryIdByKey.set(categoryKey(cat.name), cat.id);
  }
  return categoryIdByKey;
}
