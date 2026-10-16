/** 指令路由器集成测试（内存库 + mock classifier/itemParser/haClient，确定性） */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCommandRouter } from './command-router.js';
import { createDb, type AppDatabase } from '../db/client.js';
import { initSchema } from '../db/init.js';
import { createItem } from '../db/repository.js';
import { eventLogs } from '../db/schema.js';
import { HaError } from '../ha/errors.js';
import type { HaConfig } from '../ha/config.js';
import type { HaClient, HaEntityState } from '../ha/ha-client.js';
import type { IntentClassifier, IntentResult } from '../ai/intent-classifier.js';
import type { ItemParser, ParsedItem } from '../ai/item-parser.js';

/** 固定时钟。 */
const FIXED_NOW = Date.parse('2025-01-01T12:00:00+08:00');

let db: AppDatabase;

beforeEach(() => {
  const conn = createDb(':memory:');
  initSchema(conn.sqlite);
  db = conn.db;
});

/** 已配置的 HA config。 */
const CONFIGURED: HaConfig = {
  baseUrl: 'http://ha:8123',
  token: 'secret-token',
  wsUrl: 'ws://ha:8123/api/websocket',
  timeoutMs: 10000,
  reconnectBaseMs: 1000,
  reconnectMaxMs: 30000,
  stateChangedEventType: 'state_changed',
};

/** 未配置的 HA config（空 baseUrl/token）。 */
const UNCONFIGURED: HaConfig = { ...CONFIGURED, baseUrl: '', token: '' };

/** 构造 mock classifier，固定返回指定 IntentResult。 */
function makeClassifier(result: IntentResult): IntentClassifier {
  return { classify: vi.fn().mockResolvedValue(result) };
}

/** 构造 mock itemParser。 */
function makeItemParser(items: ParsedItem[]): ItemParser {
  return { parse: vi.fn().mockResolvedValue(items) };
}

/** 构造 mock haClient，仅实现用到的方法。 */
function makeHaClient(overrides: Partial<HaClient> = {}): HaClient {
  return {
    ping: vi.fn(),
    getStates: vi.fn(),
    getState: vi.fn(),
    callService: vi.fn(),
    turnOn: vi.fn().mockResolvedValue({}),
    turnOff: vi.fn().mockResolvedValue({}),
    setState: vi.fn(),
    ...overrides,
  } as HaClient;
}

/** 构造一个实体状态。 */
function entity(entity_id: string, friendly_name: string): HaEntityState {
  return { entity_id, state: 'off', attributes: { friendly_name } };
}

/** 统计 eventLogs 中 source='command' 的行数。 */
function commandLogCount(): number {
  return db.select().from(eventLogs).all().filter((r) => r.source === 'command').length;
}

describe('createCommandRouter.route', () => {
  it('(a) immediate_action + HA 已配置 + 唯一命中 → 调 turnOff、executed:true，写一条日志', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.living_room', '客厅灯'),
        entity('switch.kitchen', '厨房插座'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_off', target: '客厅灯' },
        rawText: '把客厅灯关掉',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('把客厅灯关掉');

    expect(result.intent).toBe('immediate_action');
    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.living_room');
    expect(haClient.turnOff).toHaveBeenCalledWith('light.living_room');
    expect(haClient.turnOn).not.toHaveBeenCalled();
    expect(commandLogCount()).toBe(1);
  });

  it('默认动作 turn_on：无 action 槽位时唯一命中调 turnOn', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([entity('light.living_room', '客厅灯')]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { target: '客厅灯' },
        rawText: '客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('客厅灯');

    expect(result.executed).toBe(true);
    expect(haClient.turnOn).toHaveBeenCalledWith('light.living_room');
  });

  it('(b) immediate_action + HA 未配置 → executed:false 且不调 getStates', async () => {
    const haClient = makeHaClient();
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '客厅灯' },
        rawText: '开客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: UNCONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开客厅灯');

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('HA 未配置');
    expect(haClient.getStates).not.toHaveBeenCalled();
    expect(commandLogCount()).toBe(1);
  });

  it('(c) immediate_action + 零命中 → executed:false reason 未找到匹配设备', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([entity('switch.kitchen', '厨房插座')]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '卧室灯' },
        rawText: '开卧室灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开卧室灯');

    expect(result.executed).toBe(false);
    expect(result.reason).toBe('未找到匹配设备');
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(d) immediate_action + 多命中 → executed:false candidates 含多个 entity_id', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.living_room_main', '客厅主灯'),
        entity('light.living_room_lamp', '客厅台灯'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_off', target: '客厅' },
        rawText: '关客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('关客厅灯');

    expect(result.executed).toBe(false);
    expect(result.reason).toBe('匹配到多个设备');
    expect(result.candidates).toEqual(['light.living_room_main', 'light.living_room_lamp']);
    expect(haClient.turnOff).not.toHaveBeenCalled();
  });

  it('(e) item_record → 调 itemParser.parse 且入库，source 默认 manual', async () => {
    const parsed: ParsedItem[] = [{ name: '牛奶', quantity: 2, unit: '盒' }];
    const itemParser = makeItemParser(parsed);
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({ intent: 'item_record', rawText: '买了两盒牛奶' }),
      itemParser,
      haConfig: UNCONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('买了两盒牛奶');

    expect(itemParser.parse).toHaveBeenCalledWith('买了两盒牛奶');
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0]?.name).toBe('牛奶');
    expect(result.items?.[0]?.source).toBe('manual');
    expect(commandLogCount()).toBe(1);
  });

  it('(e2) item_record → 显式 source=voice 透传入库', async () => {
    const parsed: ParsedItem[] = [{ name: '鸡蛋', quantity: 10 }];
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({ intent: 'item_record', rawText: '买了十个鸡蛋' }),
      itemParser: makeItemParser(parsed),
      haConfig: UNCONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('买了十个鸡蛋', { source: 'voice' });

    expect(result.items?.[0]?.source).toBe('voice');
  });

  it('(f) query expiring → 返回 listExpiringItems 结果', async () => {
    // 预置一个 2 天后到期的物品（落在 3 天窗口内）
    createItem(db, {
      name: '酸奶',
      source: 'manual',
      confirmed: true,
      expiryDate: FIXED_NOW + 2 * 24 * 3600 * 1000,
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'query',
        slots: { queryType: 'expiring' },
        rawText: '还有什么快过期了',
      }),
      itemParser: makeItemParser([]),
      haConfig: UNCONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('还有什么快过期了');

    expect(result.intent).toBe('query');
    expect(result.expiringItems).toHaveLength(1);
    expect(result.expiringItems?.[0]?.name).toBe('酸奶');
    expect(commandLogCount()).toBe(1);
  });

  it('(g) unknown → 返回 message 且不调 haClient/itemParser', async () => {
    const haClient = makeHaClient();
    const itemParser = makeItemParser([]);
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({ intent: 'unknown', rawText: '今天天气如何' }),
      itemParser,
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('今天天气如何');

    expect(result.intent).toBe('unknown');
    expect(result.message).toBeTruthy();
    expect(haClient.getStates).not.toHaveBeenCalled();
    expect(itemParser.parse).not.toHaveBeenCalled();
    expect(commandLogCount()).toBe(1);
  });

  it('(i) getStates 抛 HaError → executed:false 不崩，写一条日志', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockRejectedValue(new HaError('无法连接 Home Assistant', 'connection')),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '客厅灯' },
        rawText: '开客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开客厅灯');

    expect(result.executed).toBe(false);
    expect(result.reason).toBe('无法连接 Home Assistant');
    expect(commandLogCount()).toBe(1);
  });
});
