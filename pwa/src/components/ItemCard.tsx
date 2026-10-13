import type { Item } from '../api/types';
import { formatDate } from '../lib/date';
import { ExpiryBadge } from './ExpiryBadge';
import styles from './ItemCard.module.css';

interface ItemCardProps {
  item: Item;
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
}

/** 依据 daysUntilExpiry 给卡片选高亮基调类。 */
function cardTone(days: number | null): string {
  if (days === null) return '';
  if (days < 0) return styles.danger ?? '';
  if (days <= 2) return styles.warn ?? '';
  return '';
}

/** 单条物品卡片（看板与列表复用）。 */
export function ItemCard({ item, onEdit, onDelete }: ItemCardProps) {
  const quantityText = `${item.quantity}${item.unit ?? ''}`;
  return (
    <div className={`${styles.card} ${cardTone(item.daysUntilExpiry)}`}>
      <div className={styles.header}>
        <h3 className={styles.name}>{item.name}</h3>
        <ExpiryBadge daysUntilExpiry={item.daysUntilExpiry} />
      </div>
      <dl className={styles.meta}>
        <div className={styles.row}>
          <dt>数量</dt>
          <dd>{quantityText}</dd>
        </div>
        <div className={styles.row}>
          <dt>存放位置</dt>
          <dd>{item.location ?? '—'}</dd>
        </div>
        <div className={styles.row}>
          <dt>到期日</dt>
          <dd>{formatDate(item.expiryDate)}</dd>
        </div>
      </dl>
      {item.note && <p className={styles.note}>{item.note}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => onEdit(item)}>
          编辑
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.delete}`}
          onClick={() => onDelete(item)}
        >
          删除
        </button>
      </div>
    </div>
  );
}
