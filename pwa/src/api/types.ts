/** 物品来源：手动 / 语音 / 视觉识别。本任务只用 manual。 */
export type Source = 'manual' | 'voice' | 'vision';

/** 物品对象（GET 列表/详情/到期接口返回）。所有日期为 Unix 毫秒整数。 */
export interface Item {
  id: number;
  name: string;
  quantity: number;
  unit: string | null;
  categoryId: number | null;
  location: string | null;
  purchaseDate: number | null;
  shelfLifeDays: number | null;
  expiryDate: number | null;
  confirmed: boolean;
  source: Source;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** 距到期天数：负数=已过期，0=今天到期，null=无到期日。仅 list/detail/expiring 返回。 */
  daysUntilExpiry: number | null;
}

/** 分类对象。 */
export interface Category {
  id: number;
  name: string;
  icon?: string | null;
  color?: string | null;
}

/** 创建物品请求体：name 必填，日期字段用毫秒整数，其余可选。 */
export interface CreateItemBody {
  name: string;
  quantity?: number;
  unit?: string | null;
  categoryId?: number | null;
  location?: string | null;
  purchaseDate?: number | null;
  shelfLifeDays?: number | null;
  expiryDate?: number | null;
  source?: Source;
  note?: string | null;
}

/** 更新物品请求体：全部字段可选。 */
export type UpdateItemBody = Partial<CreateItemBody>;

/** 消耗 / 用完登记请求体：数量与事件类型均可选。 */
export interface ConsumeBody {
  quantity?: number;
  eventType?: 'consumed' | 'discarded';
}

/** 消耗登记返回：item 为 null 表示已用完被移除。 */
export interface ConsumeResult {
  item: Item | null;
  consumed: boolean;
  depleted: boolean;
  message: string;
}

/** 物品列表查询参数。 */
export interface ListItemsParams {
  categoryId?: number;
  location?: string;
  confirmed?: boolean;
}

/** 后端错误响应体。 */
export interface ApiErrorBody {
  error: {
    message: string;
    code?: string;
  };
}

/** 采集网关运行状态（GET /api/capture/status 返回）。 */
export type CaptureState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

/** 采集网关状态指标，对齐后端 /api/capture/status 返回体。 */
export interface CaptureStatus {
  /** 当前状态机状态 */
  state: CaptureState;
  /** 当前采集源地址，未配置时为空串 */
  sourceUrl: string;
  /** 抽帧帧率 */
  fps: number;
  /** 最近一帧时间戳（ms，Date.now()），尚无帧时为 null */
  lastFrameAt: number | null;
  /** 累计产出的完整帧数 */
  frameCount: number;
  /** 累计透传的音频字节数 */
  audioBytes: number;
  /** 累计自动重连次数 */
  reconnectAttempts: number;
  /** 源是否已配置（sourceUrl 非空） */
  configured: boolean;
}
