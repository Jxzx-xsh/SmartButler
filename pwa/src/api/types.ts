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
