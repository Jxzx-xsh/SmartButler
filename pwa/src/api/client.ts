import type {
  Category,
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
    let message = `请求失败（${res.status}）`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: { message?: string; code?: string } };
      if (data?.error?.message) message = data.error.message;
      code = data?.error?.code;
    } catch {
      // 响应体非 JSON，沿用默认兜底提示
    }
    throw new ApiError(message, res.status, code);
  }

  // 204 无响应体
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
};

/** 分类相关接口薄封装。 */
export const categoriesApi = {
  list: () => request<Category[]>('/api/categories'),
};
