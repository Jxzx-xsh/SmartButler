/**
 * Home Assistant 集成配置集中读取。
 *
 * 所有 HA 相关参数都通过环境变量注入，缺省时回退到安全的本地默认值；
 * 这样部署方可按需用环境变量覆盖，而测试/开发无需额外配置即可运行。
 *
 * 安全约束：token 为长期访问令牌，属敏感凭据，仅由环境变量注入，
 * 绝不硬编码、绝不入库、绝不写日志、绝不回显到任何响应体或错误消息中。
 */

/** Home Assistant 接入配置。 */
export interface HaConfig {
  /** HA REST API 基址，形如 http://ha:8123（去除末尾斜杠）；未配置时为空字符串 */
  baseUrl: string;
  /**
   * 长期访问令牌（敏感）。
   * 仅用于构造 Authorization 请求头与 WS 鉴权消息；
   * 绝不硬编码/入库/写日志/回显。未配置时为空字符串。
   */
  token: string;
  /** HA WebSocket 地址；缺省时从非空 baseUrl 推导（baseUrl 为空则为空字符串） */
  wsUrl: string;
  /** REST 请求超时毫秒数，默认 10000 */
  timeoutMs: number;
  /** WS 重连退避基准毫秒，默认 1000 */
  reconnectBaseMs: number;
  /** WS 重连退避上限毫秒，默认 30000 */
  reconnectMaxMs: number;
  /** 订阅的 HA 事件类型，默认 'state_changed' */
  stateChangedEventType: string;
}

/** REST 请求超时默认值。 */
const DEFAULT_TIMEOUT_MS = 10000;
/** WS 重连退避基准默认值。 */
const DEFAULT_RECONNECT_BASE_MS = 1000;
/** WS 重连退避上限默认值。 */
const DEFAULT_RECONNECT_MAX_MS = 30000;
/** 订阅事件类型默认值。 */
const DEFAULT_STATE_CHANGED_EVENT_TYPE = 'state_changed';

/**
 * 从非空 baseUrl 推导 WS 地址：http→ws、https→wss，并拼接 /api/websocket。
 * baseUrl 为空时返回空字符串（表示未配置）。
 */
function deriveWsUrl(baseUrl: string): string {
  if (baseUrl === '') {
    return '';
  }
  // 协议替换：https→wss、http→ws（只替换开头的协议前缀）
  let wsBase: string;
  if (baseUrl.startsWith('https://')) {
    wsBase = 'wss://' + baseUrl.slice('https://'.length);
  } else if (baseUrl.startsWith('http://')) {
    wsBase = 'ws://' + baseUrl.slice('http://'.length);
  } else {
    // 非 http(s) 前缀时原样拼接（容错，正常不会发生）
    wsBase = baseUrl;
  }
  return wsBase + '/api/websocket';
}

/**
 * 从环境变量读取 HA 配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadHaConfig(env: NodeJS.ProcessEnv = process.env): HaConfig {
  // baseUrl 去除末尾斜杠，便于后续直接拼接 /api/... 路径
  const baseUrl = (env.HA_BASE_URL ?? '').replace(/\/+$/, '');
  // token（敏感）：缺省空字符串
  const token = env.HA_TOKEN ?? '';
  // wsUrl：显式配置优先，否则从 baseUrl 推导
  const wsUrl = env.HA_WS_URL ?? deriveWsUrl(baseUrl);

  // 超时按 Number 解析；非法（NaN）或 <=0 统一回退到默认值（对齐 ai/config.ts 写法）
  const parsedTimeout = Number(env.HA_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  // 重连退避基准：非法或 <=0 回退默认
  const parsedReconnectBase = Number(env.HA_WS_RECONNECT_BASE_MS);
  const reconnectBaseMs =
    Number.isFinite(parsedReconnectBase) && parsedReconnectBase > 0
      ? parsedReconnectBase
      : DEFAULT_RECONNECT_BASE_MS;

  // 重连退避上限：非法或 <=0 回退默认
  const parsedReconnectMax = Number(env.HA_WS_RECONNECT_MAX_MS);
  const reconnectMaxMs =
    Number.isFinite(parsedReconnectMax) && parsedReconnectMax > 0
      ? parsedReconnectMax
      : DEFAULT_RECONNECT_MAX_MS;

  return {
    baseUrl,
    token,
    wsUrl,
    timeoutMs,
    reconnectBaseMs,
    reconnectMaxMs,
    stateChangedEventType: env.HA_WS_EVENT_TYPE ?? DEFAULT_STATE_CHANGED_EVENT_TYPE,
  };
}

/**
 * 判断 HA 是否已完成基础配置（baseUrl 与 token 均非空）。
 * 供接线层据此决定是否拉起真实连接/订阅。
 */
export function isHaConfigured(config: HaConfig): boolean {
  return config.baseUrl !== '' && config.token !== '';
}
