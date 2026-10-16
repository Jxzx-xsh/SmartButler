/**
 * 解析物品入库共用函数（Task 11 抽取）。
 *
 * 把 ParsedItem[] 落库：按分类名宽松映射到已有分类 id，构造 CreateItemInput
 * 并调 createItem 收集返回。原逻辑内联于 src/routes/voice.ts，现抽取为共用纯函数，
 * 供语音路由与后续 command-router（item_record 入库）复用。
 *
 * source 由参数传入（原 voice 固定 'voice'），其余逻辑逐字等价迁移，行为不变。
 */

import type { AppDatabase } from './client.js';
import { createItem, type CreateItemInput } from './repository.js';
import { categoryKey, buildCategoryIdMap } from './category-map.js';
import type { Item } from './schema.js';
import type { ParsedItem } from '../ai/item-parser.js';

/**
 * 把解析出的物品数组入库，返回入库记录数组。
 *
 * - 取 buildCategoryIdMap(db) 建「分类名 key → id」映射（大小写不敏感、去空白）；
 *   模型返回的 category 命中则带上 categoryId，匹配不到则不设（置空，不建新分类）。
 * - source 由参数传入，confirmed 固定为 true（录入默认已确认）。
 * - 透传 quantity/unit/location/purchaseDate/shelfLifeDays/expiryDate；
 *   createItem 在未显式给 expiryDate 时会按 purchaseDate+shelfLifeDays 自动算到期。
 *
 * @param db 数据库实例
 * @param items 解析出的物品数组
 * @param source 物品来源（'manual' | 'voice' | 'vision'）
 */
export function persistParsedItems(
  db: AppDatabase,
  items: ParsedItem[],
  source: 'manual' | 'voice' | 'vision',
): Item[] {
  // 建分类名 → id 映射（宽松匹配）
  const categoryIdByKey = buildCategoryIdMap(db);

  const created: Item[] = [];
  for (const p of items) {
    const input: CreateItemInput = {
      name: p.name,
      source,
      confirmed: true,
    };
    if (p.quantity !== null && p.quantity !== undefined) {
      input.quantity = p.quantity;
    }
    if (p.unit !== null && p.unit !== undefined) {
      input.unit = p.unit;
    }
    if (p.location !== null && p.location !== undefined) {
      input.location = p.location;
    }
    if (p.purchaseDate !== null && p.purchaseDate !== undefined) {
      input.purchaseDate = p.purchaseDate;
    }
    if (p.shelfLifeDays !== null && p.shelfLifeDays !== undefined) {
      input.shelfLifeDays = p.shelfLifeDays;
    }
    if (p.expiryDate !== null && p.expiryDate !== undefined) {
      input.expiryDate = p.expiryDate;
    }
    // 分类名映射到已有分类 id；匹配不到则不设 categoryId（置空）
    if (p.category !== null && p.category !== undefined) {
      const id = categoryIdByKey.get(categoryKey(p.category));
      if (id !== undefined) {
        input.categoryId = id;
      }
    }

    created.push(createItem(db, input));
  }
  return created;
}
