/**
 * 主动到期提醒配置集中读取。
 *
 * 所有提醒相关参数都通过环境变量注入，缺省时回退到安全的本地默认值；
 * 这样部署方可按需用环境变量覆盖，而测试/开发无需额外配置即可运行。
 * 解析范式镜像 ha/config.ts：用 Number 解析，非法（NaN）或 <=0 统一回退默认。
 */

/** 主动到期提醒配置。 */
export interface ReminderConfig {
  /** 调度器检查间隔（毫秒），默认 3600000（1 小时） */
  intervalMs: number;
  /** 临期窗口天数（N 天内到期含已过期），默认 3 */
  expiryDays: number;
}

/** 检查间隔默认值（毫秒）：1 小时。 */
const DEFAULT_INTERVAL_MS = 3_600_000;
/** 临期窗口默认天数。 */
const DEFAULT_EXPIRY_DAYS = 3;

/**
 * 从环境变量读取提醒配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadReminderConfig(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
  // 检查间隔：非法（NaN）或 <=0 回退默认
  const parsedInterval = Number(env.REMINDER_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : DEFAULT_INTERVAL_MS;

  // 临期窗口天数：非法（NaN）或 <=0 回退默认
  const parsedExpiryDays = Number(env.REMINDER_EXPIRY_DAYS);
  const expiryDays =
    Number.isFinite(parsedExpiryDays) && parsedExpiryDays > 0
      ? parsedExpiryDays
      : DEFAULT_EXPIRY_DAYS;

  return { intervalMs, expiryDays };
}
