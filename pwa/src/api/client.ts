import type {
  CaptureStatus,
  Category,
  ConsumeBody,
  ConsumeResult,
  CreateItemBody,
  Item,
  ListItemsParams,
  RecipeResult,
  SaveRecipeBody,
  SavedRecipe,
  UpdateItemBody,
} from './types';

/**
 * API 基地址：默认空字符串，使所有请求走【相对路径】（如 /api/items），跟随当前域名，
 * 由 Vite dev/preview 的 proxy 把 /api 转发到后端（见 vite.config.ts server.proxy）。
 * 这样通过内网穿透域名（如 www.xushihu.com）访问时，前端只需暴露一个入口，无需单独暴露后端端口。
 * 如需直连某个后端地址（如本地脚本调试），可用环境变量 VITE_API_BASE 覆盖为绝对地址。
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

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

/** 访问 token 在 localStorage 的存储键。 */
const TOKEN_KEY = 'smartbutler_token';

/** 读取当前访问 token（未登录返回 null）。 */
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** 存入访问 token。 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** 清除访问 token。 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 是否已登录（持有 token）。 */
export function isAuthed(): boolean {
  return getToken() !== null;
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

  // 组装请求头：有 body 带 Content-Type，有 token 带 Authorization（二者可并存）。
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // 网络层失败（后端未启动 / 跨域 / 断网）
    throw new ApiError('无法连接服务器，请确认后端已启动', 0);
  }

  // 未授权：清 token 并广播登出事件，供顶层回到登录页；仍抛错让调用方感知。
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('smartbutler:unauthorized'));
    throw await toApiError(res);
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  // 204 无响应体
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 鉴权相关接口薄封装：登录换 token、登出清 token。
 * 登录请求本身不要求已有 token（走原生 fetch，避免携带旧 token 干扰）。
 */
export async function login(password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw new ApiError('无法连接服务器，请确认后端已启动', 0);
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  const data = (await res.json()) as { token: string; expiresAt: number };
  setToken(data.token);
}

/** 登出：清除本地 token。 */
export function logout(): void {
  clearToken();
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

/** 食谱推荐相关接口薄封装。 */
export const recipesApi = {
  /** 基于家里食材推荐家常菜（days 控制临期判定窗口，缺省后端默认 3）。 */
  recommend: (days?: number) =>
    request<RecipeResult>('/api/recipes/recommend', { query: { days } }),
  /** 收藏一道食谱（允许重复，每次新增一条）。 */
  saveRecipe: (body: SaveRecipeBody) =>
    request<SavedRecipe>('/api/recipes/saved', { method: 'POST', body }),
  /** 读取已收藏食谱列表（后端按收藏时间倒序）。 */
  listSaved: () => request<SavedRecipe[]>('/api/recipes/saved'),
  /** 删除一条收藏。 */
  removeSaved: (id: number) =>
    request<void>(`/api/recipes/saved/${id}`, { method: 'DELETE' }),
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
  /** MJPEG 实时流地址，直接喂给 <img src>；<img> 无法带头，故有 token 时拼 query。 */
  streamUrl: () => {
    const token = getToken();
    return token
      ? `${API_BASE}/api/capture/stream?token=${encodeURIComponent(token)}`
      : `${API_BASE}/api/capture/stream`;
  },
  /** 最近一帧快照地址，带时间戳防缓存；有 token 时额外拼 token query。 */
  snapshotUrl: () => {
    const token = getToken();
    const q = `t=${Date.now()}`;
    return token
      ? `${API_BASE}/api/capture/snapshot?${q}&token=${encodeURIComponent(token)}`
      : `${API_BASE}/api/capture/snapshot?${q}`;
  },
  /**
   * 上传通话录音（方案 A 仅上行留存）。走原生 fetch + FormData 发 multipart，
   * 不经 JSON request 封装；复用 ApiError 风格做错误处理。
   */
  talk: async (blob: Blob): Promise<{ ok: boolean; bytes: number; note: string }> => {
    const form = new FormData();
    form.append('audio', blob, 'talk.webm');

    // 发 FormData 时不手设 Content-Type（交给浏览器带 boundary），仅在有 token 时加 Authorization。
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/capture/talk`, {
        method: 'POST',
        headers,
        body: form,
      });
    } catch {
      throw new ApiError('无法连接服务器，请确认后端已启动', 0);
    }

    if (res.status === 401) {
      clearToken();
      window.dispatchEvent(new Event('smartbutler:unauthorized'));
      throw await toApiError(res);
    }

    if (!res.ok) {
      throw await toApiError(res);
    }
    return (await res.json()) as { ok: boolean; bytes: number; note: string };
  },
};
