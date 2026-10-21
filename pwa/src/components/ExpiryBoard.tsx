import { useState } from 'react';
import type { Item } from '../api/types';
import { useExpiringQuery } from '../hooks/useItems';
import { ItemCard } from './ItemCard';
import { StatusView } from './StatusView';
import styles from './ExpiryBoard.module.css';

interface ExpiryBoardProps {
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
}

/** 可切换的到期窗口（天）。 */
const DAY_OPTIONS = [3, 7] as const;

/** 到期看板：按 N 天内到期筛选，倒计时高亮。 */
export function ExpiryBoard({ onEdit, onDelete }: ExpiryBoardProps) {
  const [days, setDays] = useState<number>(3);
  const query = useExpiringQuery(days);
  const items = query.data ?? [];

  return (
    <section>
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>到期范围</span>
        <div className={styles.tabs}>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={`${styles.tab} ${days === d ? styles.tabActive : ''}`}
              onClick={() => setDays(d)}
            >
              {d} 天内
            </button>
          ))}
        </div>
      </div>

      <StatusView
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!query.isLoading && !query.error && items.length === 0}
        emptyText={`${days} 天内没有临期物品`}
        onRetry={() => void query.refetch()}
        fullscreen
      />

      <div className={styles.list}>
        {items.map((item) => (
          <ItemCard key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
    </section>
  );
}
