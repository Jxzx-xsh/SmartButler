/**
 * 到期计算纯函数集合。
 *
 * 本模块不依赖数据库，入参使用局部结构化类型，保证可独立测试。
 * 所有时间单位与 schema 一致：**Unix 毫秒时间戳整数**。
 */

/** 一天的毫秒数 */
export const MS_PER_DAY = 86_400_000;

/** 到期计算所需的物品最小结构（仅取到期相关字段） */
export interface ExpiryLike {
  /** 到期日期（毫秒时间戳），可空 */
  expiryDate: number | null;
}

/**
 * 根据购买日期与保质期天数计算到期日期（毫秒时间戳）。
 * 两者皆为有效数值时返回 purchaseDate + shelfLifeDays * 一天毫秒，
 * 否则返回 null。
 */
export function computeExpiryDate(
  purchaseDate: number | null | undefined,
  shelfLifeDays: number | null | undefined,
): number | null {
  if (
    purchaseDate == null ||
    shelfLifeDays == null ||
    !Number.isFinite(purchaseDate) ||
    !Number.isFinite(shelfLifeDays)
  ) {
    return null;
  }
  return purchaseDate + shelfLifeDays * MS_PER_DAY;
}

/**
 * 计算距离到期还剩多少天（向上取整）。
 * - 无 expiryDate 返回 null；
 * - 已过期返回负数；
 * - 今天到期返回 0。
 */
export function daysUntilExpiry(
  item: ExpiryLike,
  now: number = Date.now(),
): number | null {
  if (item.expiryDate == null) {
    return null;
  }
  return Math.ceil((item.expiryDate - now) / MS_PER_DAY);
}

/**
 * 判断物品是否在指定天数内到期（含已过期）。
 * - 无到期日返回 false；
 * - 剩余天数 <= days 返回 true（已过期的剩余天数为负，自然满足）。
 */
export function isExpiringWithin(
  item: ExpiryLike,
  days: number,
  now: number = Date.now(),
): boolean {
  const d = daysUntilExpiry(item, now);
  return d !== null && d <= days;
}
