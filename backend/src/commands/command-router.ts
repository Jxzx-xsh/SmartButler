/**
 * 指令路由器（Task 11 意图路由主体）。
 *
 * 把一句中文指令经意图分类器分类后路由到对应处理：
 * - immediate_action：调 HA 控制设备开关（HA 未配置优雅降级，不崩）；
 * - item_record：复用 item-parser 解析 + FEAT-001 的 persistParsedItems 入库；
 * - query：返回临期物品列表（listExpiringItems，3 天内）；
 * - unknown：友好提示，不执行。
 *
 * 每次 route 统一写一条行为日志 eventLogs(source='command')，落库容错（对齐
 * ai/queue.ts emit()）。设备匹配、HA 异常、解析/入库异常均收敛进结果，不向上抛。
 *
 * 依赖注入镜像现有 createXxx 范式，便于测试注入 mock classifier/itemParser/haClient。
 */

import type { AppDatabase } from '../db/client.js';
import { eventLogs, type Item } from '../db/schema.js';
import { listExpiringItems } from '../db/repository.js';
import { persistParsedItems } from '../db/persist-items.js';
import type { IntentClassifier, Intent } from '../ai/intent-classifier.js';
import type { ItemParser } from '../ai/item-parser.js';
import type { HaClient, HaEntityState } from '../ha/ha-client.js';
import { type HaConfig, isHaConfigured } from '../ha/config.js';
import { HaError } from '../ha/errors.js';

/**
 * 指令路由结果（扁平可选字段，保证 JSON 可序列化）。
 * intent 恒有，其余字段按分支填充：
 * - immediate_action：executed/entityId/reason/candidates；
 * - item_record：items；
 * - query：expiringItems；
 * - unknown（及降级提示）：message。
 */
export interface CommandResult {
  /** 命中的意图类别 */
  intent: Intent;
  /** immediate_action：是否已执行设备控制 */
  executed?: boolean;
  /** immediate_action：唯一命中并执行的实体 id */
  entityId?: string;
  /** immediate_action：未执行原因（HA 未配置/未找到/多命中/控制失败） */
  reason?: string;
  /** immediate_action：多命中时的候选实体 id 列表 */
  candidates?: string[];
  /** item_record：入库的物品 */
  items?: Item[];
  /** query：临期物品列表 */
  expiringItems?: Item[];
  /** unknown：友好提示文案 */
  message?: string;
}

/** route 可选参数：来源（语音/手动），用于入库 source 标注。 */
export interface RouteOptions {
  source?: 'voice' | 'manual';
}

/** createCommandRouter 依赖注入入参。 */
export interface CreateCommandRouterDeps {
  /** 数据库实例（入库/查询/写行为日志） */
  db: AppDatabase;
  /** 意图分类器 */
  classifier: IntentClassifier;
  /** 物品解析器（item_record 复用） */
  itemParser: ItemParser;
  /** 可选 HA 客户端：缺省或 HA 未配置时 immediate_action 降级 */
  haClient?: HaClient;
  /** HA 配置，用于 isHaConfigured 判定 */
  haConfig: HaConfig;
  /** 当前时间来源，默认 () => Date.now()；测试注入固定时钟保证确定性 */
  now?: () => number;
}

/** 指令路由器对外句柄。 */
export interface CommandRouter {
  /** 路由一句中文指令，返回结构化结果 */
  route(text: string, opts?: RouteOptions): Promise<CommandResult>;
}

/** 临期查询天数窗口（与 /api/items/expiring 默认一致）。 */
const EXPIRING_DAYS = 3;

/**
 * 在实体状态列表中匹配目标设备，返回命中的 entity_id 列表（去重保序）。
 * - entityId 优先：精确匹配某实体的 entity_id（大小写不敏感）。
 * - 否则 target：对每个实体的 entity_id 与 attributes.friendly_name 做大小写
 *   不敏感「包含」匹配。
 * target/entityId 均缺失时返回空数组（上层据此给未找到提示）。
 */
function matchEntities(
  states: HaEntityState[],
  target?: string,
  entityId?: string,
): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      hits.push(id);
    }
  };

  if (entityId !== undefined && entityId.trim() !== '') {
    const needle = entityId.trim().toLowerCase();
    for (const s of states) {
      if (s.entity_id.toLowerCase() === needle) {
        add(s.entity_id);
      }
    }
    return hits;
  }

  if (target !== undefined && target.trim() !== '') {
    const needle = target.trim().toLowerCase();
    for (const s of states) {
      const friendly = s.attributes['friendly_name'];
      const friendlyStr = typeof friendly === 'string' ? friendly.toLowerCase() : '';
      if (s.entity_id.toLowerCase().includes(needle) || friendlyStr.includes(needle)) {
        add(s.entity_id);
      }
    }
  }

  return hits;
}

/**
 * 创建指令路由器。
 * @param deps 依赖：db/classifier/itemParser 必填，haClient 可选，haConfig 必填，now 可选。
 */
export function createCommandRouter(deps: CreateCommandRouterDeps): CommandRouter {
  const { db, classifier, itemParser, haClient, haConfig } = deps;
  const now = deps.now ?? ((): number => Date.now());

  /**
   * 写一条行为日志到 eventLogs(source='command')，落库失败吞错（对齐 queue.ts emit()）。
   * resultSummary 为精简对象，避免把完整 Item 数组塞进日志。
   */
  function writeCommandLog(intent: Intent, rawText: string, summary: unknown): void {
    try {
      db.insert(eventLogs)
        .values({
          eventType: 'command',
          payload: JSON.stringify({ intent, rawText, result: summary, timestamp: now() }),
          source: 'command',
        })
        .run();
    } catch {
      // 行为日志落库失败不影响主流程
    }
  }

  /** 处理 immediate_action：HA 降级 / 设备匹配 / 开关控制，异常收敛进结果。 */
  async function handleImmediateAction(result: {
    slots?: { action?: 'turn_on' | 'turn_off'; target?: string; entityId?: string };
  }): Promise<CommandResult> {
    // HA 未配置或未注入客户端 → 优雅降级，不执行
    if (!isHaConfigured(haConfig) || haClient === undefined) {
      return { intent: 'immediate_action', executed: false, reason: 'HA 未配置，无法执行设备控制' };
    }

    const slots = result.slots ?? {};
    try {
      const states = await haClient.getStates();
      const hits = matchEntities(states, slots.target, slots.entityId);

      if (hits.length === 0) {
        return { intent: 'immediate_action', executed: false, reason: '未找到匹配设备' };
      }
      if (hits.length > 1) {
        return {
          intent: 'immediate_action',
          executed: false,
          reason: '匹配到多个设备',
          candidates: hits,
        };
      }

      // 唯一命中：按 action 调开/关（默认 turn_on）
      const entityId = hits[0] as string;
      const action = slots.action ?? 'turn_on';
      if (action === 'turn_off') {
        await haClient.turnOff(entityId);
      } else {
        await haClient.turnOn(entityId);
      }
      return { intent: 'immediate_action', executed: true, entityId };
    } catch (err) {
      return {
        intent: 'immediate_action',
        executed: false,
        reason: err instanceof HaError ? err.message : '设备控制失败',
      };
    }
  }

  async function route(text: string, opts?: RouteOptions): Promise<CommandResult> {
    const result = await classifier.classify(text);
    let commandResult: CommandResult;

    switch (result.intent) {
      case 'immediate_action': {
        commandResult = await handleImmediateAction(result);
        break;
      }
      case 'item_record': {
        try {
          const parsed = await itemParser.parse(text);
          const items = persistParsedItems(db, parsed, opts?.source ?? 'manual');
          commandResult = { intent: 'item_record', items };
        } catch {
          // 解析/入库失败收敛为提示，不崩
          commandResult = {
            intent: 'item_record',
            items: [],
            message: '物品记录失败，请稍后再试',
          };
        }
        break;
      }
      case 'query': {
        if (result.slots?.queryType === 'expiring') {
          const expiringItems = listExpiringItems(db, EXPIRING_DAYS, now());
          commandResult = { intent: 'query', expiringItems };
        } else {
          // 未指明查询类型：按 unknown 风格给简单提示
          commandResult = { intent: 'query', message: '暂不支持该查询，请换种说法' };
        }
        break;
      }
      default: {
        commandResult = {
          intent: 'unknown',
          message: '未能识别该指令，请换种说法或稍后再试',
        };
        break;
      }
    }

    // 统一写行为日志（精简摘要）
    writeCommandLog(result.intent, text, summarizeResult(commandResult));
    return commandResult;
  }

  return { route };
}

/** 把路由结果收敛为精简摘要，供行为日志 payload 使用（避免塞入完整 Item 数组）。 */
function summarizeResult(result: CommandResult): Record<string, unknown> {
  switch (result.intent) {
    case 'immediate_action':
      return {
        executed: result.executed ?? false,
        ...(result.entityId !== undefined ? { entityId: result.entityId } : {}),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.candidates !== undefined ? { candidateCount: result.candidates.length } : {}),
      };
    case 'item_record':
      return { itemCount: result.items?.length ?? 0 };
    case 'query':
      return {
        ...(result.expiringItems !== undefined ? { expiringCount: result.expiringItems.length } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
    default:
      return { message: result.message };
  }
}
