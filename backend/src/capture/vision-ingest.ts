/**
 * 视觉入库管线（Task 8 持久化层）。
 *
 * 把视觉识别器（VisionParser）识别出的物品落库为 confirmed=false、source='vision'
 * 的待确认物品。做法：
 * - 节流：相邻两次 ingestFrame 的最小间隔（minIntervalMs），间隔内直接跳过（不调模型），
 *   避免门控高频触发时反复识别浪费算力；
 * - 去重：去重窗口（dedupWindowMs）内相同名称（按 categoryKey 归一化）只入库一次，
 *   避免同一物品被连续识别重复入库；
 * - 分类名 → id 映射：复用 FEAT-001 的 buildCategoryIdMap，命中带 categoryId，匹配不到不设；
 * - 入库：走仓储 createItem，source 固定 'vision'、confirmed 固定 false；
 * - 可观测：入库/跳过/错误落 eventLog（source='vision'），落库 try/catch 吞异常（照 queue.ts emit）。
 *
 * now 可注入固定时钟，保证节流/去重的单测确定性。
 */

import type { AppDatabase } from '../db/client.js';
import type { VisionParser } from '../ai/vision-parser.js';
import { createItem, type CreateItemInput } from '../db/repository.js';
import { categoryKey, buildCategoryIdMap } from '../db/category-map.js';
import { eventLogs, type Item } from '../db/schema.js';

/** createVisionIngest 依赖注入入参。 */
export interface CreateVisionIngestDeps {
  /** 数据库实例 */
  db: AppDatabase;
  /** 视觉识别器：把一帧 JPEG 识别为 ParsedItem[] */
  visionParser: VisionParser;
  /** 当前时间来源，默认 () => Date.now()；测试注入固定时钟保证确定性 */
  now?: () => number;
  /** 最小入库间隔（毫秒），默认 15000；间隔内的 ingestFrame 直接跳过 */
  minIntervalMs?: number;
  /** 同名去重窗口（毫秒），默认 60000；窗口内相同名称只入库一次 */
  dedupWindowMs?: number;
}

/** 视觉入库管线对外句柄。 */
export interface VisionIngest {
  /** 识别并入库一帧 JPEG，返回本次入库的物品数组（节流/去重跳过时返回 []） */
  ingestFrame(jpeg: Buffer, timestamp: number): Promise<Item[]>;
  /** 读取入库统计快照 */
  getStats(): { lastIngestAt: number | null; ingestedCount: number };
}

/** 默认最小入库间隔：15 秒。 */
const DEFAULT_MIN_INTERVAL_MS = 15000;
/** 默认同名去重窗口：60 秒。 */
const DEFAULT_DEDUP_WINDOW_MS = 60000;

/**
 * 创建视觉入库管线。
 * @param deps 依赖：db、visionParser（必填）；now/minIntervalMs/dedupWindowMs（可选）。
 */
export function createVisionIngest(deps: CreateVisionIngestDeps): VisionIngest {
  const { db, visionParser } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const dedupWindowMs = deps.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;

  // 内部状态：上次入库时间、最近入库名称→时间、累计入库数
  let lastIngestAt: number | null = null;
  const recentNames = new Map<string, number>();
  let ingestedCount = 0;

  /** 落 eventLog，失败吞异常不影响主流程（照 queue.ts emit）。 */
  function logEvent(eventType: string, payload: Record<string, unknown>): void {
    try {
      db.insert(eventLogs)
        .values({
          eventType,
          payload: JSON.stringify(payload),
          source: 'vision',
        })
        .run();
    } catch {
      // 事件日志落库失败不影响主流程
    }
  }

  /** 清理去重表中已超出去重窗口的过期条目。 */
  function pruneRecentNames(current: number): void {
    for (const [key, at] of recentNames) {
      if (current - at > dedupWindowMs) {
        recentNames.delete(key);
      }
    }
  }

  async function ingestFrame(jpeg: Buffer, timestamp: number): Promise<Item[]> {
    // (a) 最小间隔节流：间隔内直接跳过，不调用识别器
    if (lastIngestAt !== null && now() - lastIngestAt < minIntervalMs) {
      logEvent('vision_skip', { reason: 'throttle', timestamp });
      return [];
    }

    // (b) 调用视觉识别器识别本帧
    const parsed = await visionParser.parseFrame(jpeg, timestamp);

    // (c) 建分类名 → id 映射（宽松匹配，匹配不到不设）
    const categoryIdByKey = buildCategoryIdMap(db);

    // (d) 逐条去重 + 入库
    const created: Item[] = [];
    for (const p of parsed) {
      const key = categoryKey(p.name);
      // 去重：窗口内同名已入库则跳过该条
      const recentAt = recentNames.get(key);
      if (recentAt !== undefined && now() - recentAt <= dedupWindowMs) {
        continue;
      }

      const input: CreateItemInput = {
        name: p.name,
        source: 'vision',
        confirmed: false,
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
      // 分类名映射到已有分类 id；匹配不到则不设 categoryId
      if (p.category !== null && p.category !== undefined) {
        const id = categoryIdByKey.get(categoryKey(p.category));
        if (id !== undefined) {
          input.categoryId = id;
        }
      }

      created.push(createItem(db, input));
      recentNames.set(key, now());
    }

    // (e) 清理去重表中过期条目
    pruneRecentNames(now());

    // (f) 有入库则更新节流/统计并落 vision_ingest 事件
    if (created.length > 0) {
      lastIngestAt = now();
      ingestedCount += created.length;
      logEvent('vision_ingest', {
        count: created.length,
        names: created.map((item) => item.name),
        timestamp,
      });
    }

    // (g) 返回本次入库的物品数组
    return created;
  }

  function getStats(): { lastIngestAt: number | null; ingestedCount: number } {
    return { lastIngestAt, ingestedCount };
  }

  return { ingestFrame, getStats };
}
