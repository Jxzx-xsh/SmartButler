/**
 * Home Assistant REST 客户端封装。
 *
 * 职责：对 HA 的 REST API（/api/ 下各端点）做最小封装，对外暴露
 * ping / getStates / getState / callService / turnOn / turnOff / setState，
 * 并把底层 fetch/网络/HA 响应的各类错误统一映射为带 kind 的 HaError。
 *
 * 注入范式：镜像 src/ai/lmstudio.ts 的依赖注入——createHaClient(deps={}) 中
 * config = deps.config ?? loadHaConfig()、fetchFn = deps.fetch ?? globalThis.fetch，
 * 测试时注入 mock fetch 即可脱离真实网络、不触真实 HA。
 *
 * 令牌安全约束：长期访问令牌仅出现在 Authorization 请求头的构造处，
 * 绝不 console.log、绝不进返回体、绝不进任何 HaError.message。
 */

import { loadHaConfig, type HaConfig } from './config.js';
import { HaError } from './errors.js';

/** HA 实体状态对象（REST /api/states 返回的单个实体结构，取用到的字段）。 */
export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/** 对外 HA 客户端接口。 */
export interface HaClient {
  /** 探测连通性：GET /api/，正常返回 true（连接失败按 connection 抛出，调用方可 catch） */
  ping(): Promise<boolean>;
  /** 获取全部实体状态：GET /api/states */
  getStates(): Promise<HaEntityState[]>;
  /** 获取单个实体状态：GET /api/states/<entityId>（不存在按 not_found 抛出） */
  getState(entityId: string): Promise<HaEntityState>;
  /** 调用服务：POST /api/services/<domain>/<service> */
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<unknown>;
  /** 打开实体（走通用 homeassistant 域，兼容 light/switch 等） */
  turnOn(entityId: string): Promise<unknown>;
  /** 关闭实体（走通用 homeassistant 域，兼容 light/switch 等） */
  turnOff(entityId: string): Promise<unknown>;
  /** 维护自有传感器实体状态：POST /api/states/<entityId> */
  setState(entityId: string, body: { state: string; attributes?: Record<string, unknown> }): Promise<unknown>;
}

/** createHaClient 依赖注入入参。 */
export interface CreateHaClientDeps {
  /** HA 配置，缺省调用 loadHaConfig() */
  config?: HaConfig;
  /** 注入的 fetch 实现，缺省 globalThis.fetch（测试注入 mock） */
  fetch?: typeof fetch;
}

/** HTTP 方法（本封装仅用到 GET/POST）。 */
type HttpMethod = 'GET' | 'POST';

/**
 * 把 fetch 抛出的底层错误映射为 HaError。
 * - code 为 ECONNREFUSED/ENOTFOUND 或 message 含 'fetch failed' → connection
 * - AbortError（超时触发 abort）→ connection
 * - 其余 → connection（REST 调用阶段的异常统一按连接类处理，消息不含敏感信息）
 * 注意：绝不把令牌或响应体细节带入错误消息。
 */
function mapFetchError(err: unknown): HaError {
  if (err instanceof HaError) {
    return err;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const name = err.name;
    const msg = err.message ?? '';
    // 用户/超时中止
    if (name === 'AbortError' || /aborted|abort/i.test(msg)) {
      return new HaError('连接 Home Assistant 超时', 'connection', err);
    }
    // 常见连接失败特征
    if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)
    ) {
      return new HaError('无法连接 Home Assistant', 'connection', err);
    }
  }
  return new HaError('无法连接 Home Assistant', 'connection', err);
}

/**
 * 创建 HA REST 客户端。
 * @param deps 可选依赖：config 与 fetch（测试用注入）。
 */
export function createHaClient(deps: CreateHaClientDeps = {}): HaClient {
  const config = deps.config ?? loadHaConfig();
  const fetchFn: typeof fetch = deps.fetch ?? globalThis.fetch;

  /**
   * 统一请求：拼 url、设 Authorization（令牌仅出现在此处）、带超时，
   * 并把响应状态码映射为对应 HaError kind。返回原始 Response 供调用方按需解析。
   */
  async function request(method: HttpMethod, path: string, body?: unknown): Promise<Response> {
    const url = config.baseUrl + path;
    // 令牌仅在此处构造进 Authorization 头，绝不外泄
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    };

    // 超时控制：AbortController + 定时器，finally 清理定时器避免悬挂
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    let res: Response;
    try {
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      res = await fetchFn(url, init);
    } catch (err) {
      throw mapFetchError(err);
    } finally {
      clearTimeout(timer);
    }

    // 状态码归类（消息不含令牌）
    if (res.status === 401) {
      throw new HaError('Home Assistant 未授权，请检查长期访问令牌', 'auth');
    }
    if (res.status === 404) {
      throw new HaError('Home Assistant 资源不存在', 'not_found');
    }
    if (!res.ok) {
      throw new HaError(`Home Assistant 返回异常状态：${res.status}`, 'bad_response');
    }
    return res;
  }

  /** 解析响应 JSON，失败按 bad_response 处理。 */
  async function parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      throw new HaError('Home Assistant 返回的内容无法解析为 JSON', 'bad_response', err);
    }
  }

  async function ping(): Promise<boolean> {
    const res = await request('GET', '/api/');
    const data = await parseJson(res);
    // 期望 { message: 'API running.' }
    const message = (data as { message?: unknown } | null)?.message;
    return message === 'API running.';
  }

  async function getStates(): Promise<HaEntityState[]> {
    const res = await request('GET', '/api/states');
    const data = await parseJson(res);
    if (!Array.isArray(data)) {
      throw new HaError('Home Assistant 返回的状态列表结构异常', 'bad_response', data);
    }
    return data as HaEntityState[];
  }

  async function getState(entityId: string): Promise<HaEntityState> {
    const res = await request('GET', `/api/states/${encodeURIComponent(entityId)}`);
    const data = await parseJson(res);
    return data as HaEntityState;
  }

  async function callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await request('POST', `/api/services/${domain}/${service}`, data ?? {});
    return parseJson(res);
  }

  // 用通用 homeassistant 域调用 turn_on/turn_off，可兼容 light/switch 等多种域，
  // 由 HA 根据 entity_id 自行路由到对应组件。
  async function turnOn(entityId: string): Promise<unknown> {
    return callService('homeassistant', 'turn_on', { entity_id: entityId });
  }

  async function turnOff(entityId: string): Promise<unknown> {
    return callService('homeassistant', 'turn_off', { entity_id: entityId });
  }

  async function setState(
    entityId: string,
    body: { state: string; attributes?: Record<string, unknown> },
  ): Promise<unknown> {
    const res = await request('POST', `/api/states/${encodeURIComponent(entityId)}`, body);
    return parseJson(res);
  }

  return { ping, getStates, getState, callService, turnOn, turnOff, setState };
}
