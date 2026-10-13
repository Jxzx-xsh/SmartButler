import styles from './ExpiryBadge.module.css';

interface ExpiryBadgeProps {
  /** 后端返回的距到期天数：负=已过期，0=今天，null=无到期日。 */
  daysUntilExpiry: number | null;
}

type Tone = 'danger' | 'warn' | 'ok' | 'muted';

/** 依据 daysUntilExpiry 计算文案与配色基调。 */
function resolve(days: number | null): { text: string; tone: Tone } {
  if (days === null) return { text: '无到期日', tone: 'muted' };
  if (days < 0) return { text: `已过期 ${Math.abs(days)} 天`, tone: 'danger' };
  if (days === 0) return { text: '今天到期', tone: 'warn' };
  if (days === 1) return { text: '明天到期', tone: 'warn' };
  if (days <= 2) return { text: `还有 ${days} 天`, tone: 'warn' };
  return { text: `还有 ${days} 天`, tone: 'ok' };
}

/** 到期倒计时徽标。 */
export function ExpiryBadge({ daysUntilExpiry }: ExpiryBadgeProps) {
  const { text, tone } = resolve(daysUntilExpiry);
  return <span className={`${styles.badge} ${styles[tone]}`}>{text}</span>;
}
