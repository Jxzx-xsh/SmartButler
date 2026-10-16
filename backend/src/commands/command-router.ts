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
 * 中文结构助词集合：归一化时删除这些字。
 * 仅取最常引起 target 与 friendly_name 差异的虚词，只删虚词、不删名词用字，
 * 避免误伤设备名（如「的灯」里的「的」应删，「灯」保留）。
 */
const MATCH_PARTICLES = ['的', '地', '得'] as const;

/**
 * 关键词切分停用词集合：第 2 级关键词匹配时作为切分边界并剔除。
 * 取设备控制领域最小且明确的量词/指示代词虚词，保守集合，避免过度切碎名词。
 */
const MATCH_STOPWORDS = ['所有', '那个', '这个', '那', '这', '个', '只', '台', '盏'] as const;

/**
 * 可开关语义 domain 白名单：开关类 action（turn_on/turn_off）下只保留这些 domain 的候选。
 * light（灯）/ switch（插座开关）/ fan（风扇）/ climate（空调温控）均有明确的开/关语义。
 * 排除 button（只触发一次、无持续开关态）/ select（选项选择）/ sensor（只读传感器）/
 * scene（场景，非单设备开关）等——它们不应响应「打开/关闭某设备」，否则会误控。
 * 真机场景：「晾衣机灯开关状态切换」是 button，会与 light 一起被归一化命中，需在此剔除。
 */
const SWITCHABLE_DOMAINS = ['light', 'switch', 'fan', 'climate'] as const;

/** 从 entity_id 取 domain（HA REST 契约保证形如 `domain.object_id`）。 */
function domainOf(entityId: string): string {
  return entityId.split('.')[0] ?? '';
}

/**
 * 归一化字符串用于匹配比较（等价归一化，不改变语义）：
 * 1. 转小写（兼容英文 friendly_name，大小写不敏感）；
 * 2. 去除所有空白——含半角空白与全角空格 \u3000（防某些环境 \s 不含全角空格）；
 * 3. 删除常见中文结构助词（的/地/得）。
 * 例：「晾衣机的灯」→「晾衣机灯」，「晾衣机  灯」→「晾衣机灯」，二者归一后一致。
 */
function normalizeForMatch(s: string): string {
  let out = s.toLowerCase().replace(/[\s\u3000]+/g, '');
  for (const p of MATCH_PARTICLES) {
    out = out.split(p).join('');
  }
  return out;
}

/**
 * 把归一化后的 target 按停用词边界切分成关键词片段（纯规则，无分词依赖）。
 * 以停用词为分隔符切开，过滤空片段，返回保序去空的关键词数组。
 * 例：「所有客厅灯」→（去「所有」）→「客厅灯」；「客厅那盏灯」→「客厅」「灯」。
 */
function splitKeywords(normalized: string): string[] {
  let segments = [normalized];
  for (const sw of MATCH_STOPWORDS) {
    const next: string[] = [];
    for (const seg of segments) {
      for (const part of seg.split(sw)) {
        next.push(part);
      }
    }
    segments = next;
  }
  return segments.filter((seg) => seg !== '');
}

/**
 * 在实体状态列表中匹配目标设备，返回命中的 entity_id 列表（去重保序）。
 *
 * 匹配策略（精度优先、分级降级，任一级命中即停，不混用降低精度）：
 * - 第 0 级 entityId 精确匹配：entityId 非空时精确匹配某实体的 entity_id
 *   （大小写不敏感），命中即返回，不进 target 分支。
 * - 第 1 级归一化包含匹配：对 target 与 entity_id/friendly_name 做
 *   normalizeForMatch（去空格/去助词/小写）后，做「包含」匹配。解决真机
 *   「晾衣机的灯」vs「晾衣机  灯」这类空格/助词差异（等价归一化，零精度损失）。
 * - 第 2 级关键词全覆盖匹配（仅第 1 级零命中时启用，补充召回）：把归一化 target
 *   按停用词切成关键词，要求某实体 friendly_name 归一化后「包含全部关键词」
 *   （AND 语义）才命中。护栏：单字单关键词不启用（易误中）、只比对 friendly_name
 *   （不对无语义 entity_id 长串做关键词匹配，避免偶然子串命中）。
 *
 * 命中 ≥2 个时上层走多候选确认分支，绝不自行挑一个执行（控制设备有副作用，
 * 宁可多问也不误控）。target/entityId 均缺失时返回空数组。
 *
 * 多候选收敛（方案 C，仅对 target 分支的候选生效；entityId 分支已显式指名，不收敛）：
 * 在三级匹配产出候选后、返回前，统一做两步收敛：
 *  1) 动作→domain 过滤：当 action 为 turn_on/turn_off 时，只保留 SWITCHABLE_DOMAINS
 *     内的候选（排除 button/select/sensor/scene 等）；若过滤后全空（候选里全是不可
 *     开关设备）则返回空集，交上层走「未找到匹配设备」，绝不误控。action 未提供或
 *     非开关类时不过滤，保持通用行为。
 *  2) 最优名匹配：domain 过滤后仍 ≥2 个候选时，取 friendly_name 归一化后与 target
 *     归一化「完全相等」的候选；若恰好唯一则收敛执行，否则（0 个或 ≥2 个同等相等）
 *     仍返回全部候选交用户澄清——完全相等是零歧义硬判据，不猜测、不误控。
 */
function matchEntities(
  states: HaEntityState[],
  target?: string,
  entityId?: string,
  action?: 'turn_on' | 'turn_off',
): string[] {
  const hits: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      hits.push(id);
    }
  };

  // 取某实体归一化后的 friendly_name（attributes.friendly_name 类型为 unknown，
  // 非字符串按空串处理）。
  const friendlyOf = (s: HaEntityState): string => {
    const friendly = s.attributes['friendly_name'];
    return typeof friendly === 'string' ? normalizeForMatch(friendly) : '';
  };

  // 第 0 级：entityId 精确匹配（大小写不敏感），命中即返回。
  if (entityId !== undefined && entityId.trim() !== '') {
    const needle = entityId.trim().toLowerCase();
    for (const s of states) {
      if (s.entity_id.toLowerCase() === needle) {
        add(s.entity_id);
      }
    }
    return hits;
  }

  if (target === undefined || target.trim() === '') {
    return hits;
  }

  // 第 1 级：归一化包含匹配（friendly_name 与 entity_id 都参与）。
  const nTarget = normalizeForMatch(target);
  if (nTarget !== '') {
    for (const s of states) {
      const nFriendly = friendlyOf(s);
      const nEntityId = normalizeForMatch(s.entity_id);
      if (nEntityId.includes(nTarget) || (nFriendly !== '' && nFriendly.includes(nTarget))) {
        add(s.entity_id);
      }
    }
  }

  // 第 2 级：关键词全覆盖匹配（仅第 1 级零命中时启用；仅 friendly_name，AND 语义，带护栏）。
  if (hits.length === 0) {
    const keywords = splitKeywords(nTarget);
    // 护栏：单字单关键词太容易误中无关实体，不启用第 2 级，维持零命中。
    const singleShortKeyword = keywords.length === 1 && (keywords[0] as string).length < 2;
    if (keywords.length > 0 && !singleShortKeyword) {
      for (const s of states) {
        const nFriendly = friendlyOf(s);
        if (nFriendly === '') {
          continue;
        }
        // 要求全部关键词都出现在同一实体 friendly_name 中才命中。
        if (keywords.every((kw) => nFriendly.includes(kw))) {
          add(s.entity_id);
        }
      }
    }
  }

  // 收敛（方案 C）：三级匹配得到 hits 后统一应用，零候选直接返回。
  if (hits.length === 0) {
    return hits;
  }

  // 收敛步骤 1：动作→domain 过滤（仅开关类 action 生效）。
  let converged = hits;
  if (action === 'turn_on' || action === 'turn_off') {
    const filtered = converged.filter((id) =>
      (SWITCHABLE_DOMAINS as readonly string[]).includes(domainOf(id)),
    );
    // 候选全被 domain 过滤掉（全是不可开关设备）→ 返回空集，交上层走「未找到匹配设备」，不误控。
    if (filtered.length === 0) {
      return [];
    }
    converged = filtered;
  }

  // 收敛步骤 2：最优名匹配（过滤后仍 ≥2 个候选时，取归一化完全相等者）。
  if (converged.length > 1 && nTarget !== '') {
    const byId = new Map<string, HaEntityState>();
    for (const s of states) {
      byId.set(s.entity_id, s);
    }
    const exact = converged.filter((id) => {
      const s = byId.get(id);
      return s !== undefined && friendlyOf(s) === nTarget;
    });
    // 唯一完全相等 → 收敛为该实体；否则（0 个或 ≥2 个同等相等）仍返回全部候选交用户澄清。
    if (exact.length === 1) {
      return exact;
    }
  }

  return converged;
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
      const hits = matchEntities(states, slots.target, slots.entityId, slots.action);

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
