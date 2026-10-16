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

  it('(j) 真机复现：target "晾衣机的灯" + friendly_name "晾衣机  灯"（两空格）→ 归一化后唯一命中执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        // 真机实体：friendly_name 含两个空格，entity_id 无语义长串
        entity('light.hyd_cn_945476182_1s1_s_3_light', '晾衣机  灯'),
        entity('switch.kitchen', '厨房插座'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '晾衣机的灯' },
        rawText: '把晾衣机的灯打开',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('把晾衣机的灯打开');

    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOn).toHaveBeenCalledWith('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOff).not.toHaveBeenCalled();
  });

  it('(k) target "晾衣机灯"（无助词无空格）同实体 → 同样唯一命中执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.hyd_cn_945476182_1s1_s_3_light', '晾衣机  灯'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '晾衣机灯' },
        rawText: '开晾衣机灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开晾衣机灯');

    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOn).toHaveBeenCalledWith('light.hyd_cn_945476182_1s1_s_3_light');
  });

  it('(l) 归一化：助词/多余空格/大小写都不影响匹配（friendly_name 含全角空格+大写）', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        // friendly_name 含全角空格 \u3000 与大写字母
        entity('light.balcony_LED', 'LED　晾衣机的灯'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_off', target: 'led晾衣机灯' },
        rawText: '关掉led晾衣机灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('关掉led晾衣机灯');

    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.balcony_LED');
    expect(haClient.turnOff).toHaveBeenCalledWith('light.balcony_LED');
  });

  it('(m) 归一化后多命中仍走多候选：target "客厅的 灯" 对「客厅灯主」「客厅灯侧」', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.living_room_main', '客厅灯主'),
        entity('light.living_room_side', '客厅灯侧'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        // 含助词「的」与空格，归一化后为「客厅灯」，是两实体 friendly_name 的子串
        slots: { action: 'turn_on', target: '客厅的 灯' },
        rawText: '开客厅的灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开客厅的灯');

    // 归一化「客厅的 灯」→「客厅灯」，第 1 级即对两实体包含命中 → 多候选
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('匹配到多个设备');
    expect(result.candidates).toEqual(['light.living_room_main', 'light.living_room_side']);
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(m2) 第 2 级保守性：target "客厅灯" 对「客厅主灯」「客厅台灯」→ 关键词整体不覆盖仍零命中', async () => {
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
        // 归一化「客厅灯」在第 1 级非子串（实体是「客厅主灯」/「客厅台灯」），
        // 第 2 级用停用词「台」切分后关键词仍需全覆盖 → 走多候选兜底
        slots: { action: 'turn_on', target: '客厅灯' },
        rawText: '开客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开客厅灯');

    // 第 1 级零命中；第 2 级关键词「客厅灯」整体不在任一实体 → 仍零命中
    // （验证第 2 级 AND 覆盖的保守性：不会把「客厅灯」误拆成「客厅」+「灯」放大召回）
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('未找到匹配设备');
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(n) 单字关键词护栏：target "灯" 面对多个含「灯」实体 → 不误执行单一设备（多候选）', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.a', '客厅灯'),
        entity('light.b', '卧室灯'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '灯' },
        rawText: '开灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开灯');

    // 第 1 级归一化包含「灯」即多命中 → 多候选，不误执行单一设备
    expect(result.executed).toBe(false);
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(o) 单字关键词护栏：唯一含「灯」实体但 target 为单字 → 第 1 级命中唯一则执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([entity('light.only', '客厅灯')]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '灯' },
        rawText: '开灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开灯');

    // 单字 target「灯」经第 1 级归一化包含命中唯一实体即执行（护栏仅限制第 2 级）
    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.only');
  });

  it('(p) 精度边界：无关 target "卧室灯" 对只有「晾衣机  灯」的实体 → 零命中不误匹配', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.hyd_cn_945476182_1s1_s_3_light', '晾衣机  灯'),
      ]),
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

    // 关键词「卧室灯」整体不是「晾衣机灯」子串，且第 2 级要求全关键词覆盖 → 零命中
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('未找到匹配设备');
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(q) 方案 C 真机根因修复：turn_on + light/button/select 同名候选 → domain 过滤排除 button/select，唯一 light 命中执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        // 用户要开的灯（light）
        entity('light.hyd_cn_945476182_1s1_s_3_light', '晾衣机  灯'),
        // 同名的 button「开关状态切换」—— 归一化后 includes「晾衣机灯」会一起命中，需被 domain 过滤剔除
        entity('button.hyd_cn_945476182_1s1_toggle_a_3_1', '晾衣机  灯 开关状态切换'),
        // 同名的 select「夜灯开关」—— 同样需被 domain 过滤剔除
        entity('select.hyd_cn_945476182_1s1_night', '晾衣机  灯 夜灯开关设置'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '晾衣机的灯' },
        rawText: '把晾衣机的灯打开',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('把晾衣机的灯打开');

    // 改进前：三者归一化都 includes「晾衣机灯」→ 多候选、不执行；
    // 改进后：domain 过滤剔除 button/select → 唯一 light → 执行。
    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOn).toHaveBeenCalledWith('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOn).toHaveBeenCalledTimes(1);
    expect(haClient.turnOff).not.toHaveBeenCalled();
  });

  it('(r) 方案 C 最优名收敛：domain 过滤后仍多个 light，归一化完全相等者唯一命中执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        // 完全相等者（归一化「晾衣机灯」）
        entity('light.a', '晾衣机  灯'),
        // 更长名（归一化「晾衣机灯开关状态切换」，非完全相等）
        entity('light.b', '晾衣机  灯 开关状态切换'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '晾衣机灯' },
        rawText: '开晾衣机灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开晾衣机灯');

    // 两个均为 light（domain 过滤都保留）→ 最优名：仅 light.a 归一化完全相等 → 唯一命中执行。
    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.a');
    expect(haClient.turnOn).toHaveBeenCalledWith('light.a');
  });

  it('(s) 方案 C 最优名无唯一完全相等 → 仍返回多候选，不猜测不误控', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.main', '客厅主灯'),
        entity('light.side', '客厅侧灯'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        // 归一化「客厅灯」用停用词无法单字切分；第 2 级关键词「客厅灯」整体不在任一实体，
        // 故此处构造为能命中两 light 的 target：用「客厅」让两者第 1 级命中。
        slots: { action: 'turn_on', target: '客厅' },
        rawText: '开客厅灯',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开客厅灯');

    // 两 light 均被 domain 保留；无一归一化等于「客厅」→ 仍多候选。
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('匹配到多个设备');
    expect(result.candidates).toEqual(['light.main', 'light.side']);
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(t) 方案 C domain 过滤后全空 → 未找到匹配设备，不误控 button', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        // 候选里只有不可开关的 button
        entity('button.hyd_cn_945476182_1s1_toggle_a_3_1', '晾衣机  灯 开关状态切换'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '晾衣机灯开关状态切换' },
        rawText: '打开晾衣机灯开关状态切换',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('打开晾衣机灯开关状态切换');

    // 第 1 级命中 button → domain 过滤后空 → 返回空集 → 未找到匹配设备，turnOn 不被调。
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('未找到匹配设备');
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(u) 方案 C action 未提供 → 不做 domain 过滤（保持通用），唯一 button 候选仍默认 turn_on 执行', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('button.doorbell', '门铃'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        // 无 action 槽位 → 不触发 domain 过滤；唯一命中 button → handleImmediateAction 默认 turn_on。
        slots: { target: '门铃' },
        rawText: '门铃',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('门铃');

    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('button.doorbell');
    expect(haClient.turnOn).toHaveBeenCalledWith('button.doorbell');
  });

  it('(v) 方案 C turn_off 同样触发 domain 过滤 → 唯一 light 命中调 turnOff', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('light.hyd_cn_945476182_1s1_s_3_light', '晾衣机  灯'),
        entity('button.hyd_cn_945476182_1s1_toggle_a_3_1', '晾衣机  灯 开关状态切换'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_off', target: '晾衣机的灯' },
        rawText: '把晾衣机的灯关掉',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('把晾衣机的灯关掉');

    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOff).toHaveBeenCalledWith('light.hyd_cn_945476182_1s1_s_3_light');
    expect(haClient.turnOn).not.toHaveBeenCalled();
  });

  it('(w) 方案 C 白名单含 fan：turn_on 唯一命中 fan → 执行（验证白名单非仅 light/switch）', async () => {
    const haClient = makeHaClient({
      getStates: vi.fn().mockResolvedValue([
        entity('fan.bedroom', '卧室风扇'),
        // 同名的 sensor，应被 domain 过滤剔除
        entity('sensor.bedroom_fan_speed', '卧室风扇转速'),
      ]),
    });
    const router = createCommandRouter({
      db,
      classifier: makeClassifier({
        intent: 'immediate_action',
        slots: { action: 'turn_on', target: '卧室风扇' },
        rawText: '开卧室风扇',
      }),
      itemParser: makeItemParser([]),
      haClient,
      haConfig: CONFIGURED,
      now: () => FIXED_NOW,
    });

    const result = await router.route('开卧室风扇');

    // fan 在白名单 → 保留；sensor 被剔除 → 唯一 fan 命中执行。
    expect(result.executed).toBe(true);
    expect(result.entityId).toBe('fan.bedroom');
    expect(haClient.turnOn).toHaveBeenCalledWith('fan.bedroom');
  });
});
