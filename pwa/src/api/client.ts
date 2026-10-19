import type {
  CaptureStatus,
  Category,
  ConsumeBody,
  ConsumeResult,
  CreateItemBody,
  Item,
  ListItemsParams,
  UpdateItemBody,
} from './types';

/** API 基地址：优先环境变量，默认本地 Fastify。 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

/** 携带中文可读信息的 API 错误。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** 把查询参数对象拼成查询串（跳过 undefined）。 */
function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** 统一请求封装：拼 URL、JSON 收发、错误解析、204 返回 void。 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = options;
  const url = `${API_BASE}${path}${buildQuery(query)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // 网络层失败（后端未启动 / 跨域 / 断网）
    throw new ApiError('无法连接服务器，请确认后端已启动', 0);
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  // 204 无响应体
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 从非 2xx 响应解析统一错误体 { error: { message, code? } }，兜底状态码提示。 */
async function toApiError(res: Response): Promise<ApiError> {
  let message = `请求失败（${res.status}）`;
  let code: string | undefined;
  try {
    const data = (await res.json()) as { error?: { message?: string; code?: string } };
    if (data?.error?.message) message = data.error.message;
    code = data?.error?.code;
  } catch {
    // 响应体非 JSON，沿用默认兜底提示
  }
  return new ApiError(message, res.status, code);
}

/** 物品相关接口薄封装。 */
export const itemsApi = {
  list: (params?: ListItemsParams) =>
    request<Item[]>('/api/items', {
      query: {
        categoryId: params?.categoryId,
        location: params?.location,
        confirmed: params?.confirmed,
      },
    }),
  listExpiring: (days: number) =>
    request<Item[]>('/api/items/expiring', { query: { days } }),
  get: (id: number) => request<Item>(`/api/items/${id}`),
  create: (body: CreateItemBody) =>
    request<Item>('/api/items', { method: 'POST', body }),
  update: (id: number, body: UpdateItemBody) =>
    request<Item>(`/api/items/${id}`, { method: 'PATCH', body }),
  remove: (id: number) => request<void>(`/api/items/${id}`, { method: 'DELETE' }),
  consume: (id: number, body?: ConsumeBody) =>
    request<ConsumeResult>(`/api/items/${id}/consume`, { method: 'POST', body: body ?? {} }),
};

/** 分类相关接口薄封装。 */
export const categoriesApi = {
  list: () => request<Category[]>('/api/categories'),
};

/** 采集网关相关接口薄封装。 */
export const captureApi = {
  /** 读取采集状态（轮询用）。 */
  status: () => request<CaptureStatus>('/api/capture/status'),
  /** 启动采集：切换源 + 启动，返回最新状态。 */
  start: (body: { url: string; fps?: number }) =>
    request<CaptureStatus>('/api/capture/start', { method: 'POST', body }),
  /** 停止采集，返回最新状态。 */
  stop: () => request<CaptureStatus>('/api/capture/stop', { method: 'POST' }),
  /** MJPEG 实时流地址，直接喂给 <img src>。 */
  streamUrl: () => `${API_BASE}/api/capture/stream`,
  /** 最近一帧快照地址，带时间戳防缓存。 */
  snapshotUrl: () => `${API_BASE}/api/capture/snapshot?t=${Date.now()}`,
  /**
   * 上传通话录音（方案 A 仅上行留存）。走原生 fetch + FormData 发 multipart，
   * 不经 JSON request 封装；复用 ApiError 风格做错误处理。
   */
  talk: async (blob: Blob): Promise<{ ok: boolean; bytes: number; note: string }> => {
    const form = new FormData();
    form.append('audio', blob, 'talk.webm');

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/capture/talk`, {
        method: 'POST',
        body: form,
      });
    } catch {
      throw new ApiError('无法连接服务器，请确认后端已启动', 0);
    }

    if (!res.ok) {
      throw await toApiError(res);
    }
    return (await res.json()) as { ok: boolean; bytes: number; note: string };
  },
};
