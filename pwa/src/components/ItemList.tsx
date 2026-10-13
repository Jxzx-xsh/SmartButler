import { useMemo, useState } from 'react';
import type { Item, ListItemsParams } from '../api/types';
import { useCategoriesQuery } from '../hooks/useCategories';
import { useItemsQuery } from '../hooks/useItems';
import { ItemCard } from './ItemCard';
import { StatusView } from './StatusView';
import styles from './ItemList.module.css';

interface ItemListProps {
  onAdd: () => void;
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
}

/** 全部物品列表：按分类 / 位置过滤。 */
export function ItemList({ onAdd, onEdit, onDelete }: ItemListProps) {
  const [categoryId, setCategoryId] = useState('');
  const [location, setLocation] = useState('');

  const categoriesQuery = useCategoriesQuery();

  const params = useMemo<ListItemsParams>(() => {
    const p: ListItemsParams = {};
    if (categoryId) p.categoryId = Number(categoryId);
    if (location.trim()) p.location = location.trim();
    return p;
  }, [categoryId, location]);

  const query = useItemsQuery(params);
  const items = query.data ?? [];

  return (
    <section>
      <div className={styles.toolbar}>
        <div className={styles.filter}>
          <label className={styles.filterLabel} htmlFor="filter-category">
            分类
          </label>
          <select
            id="filter-category"
            className={styles.control}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">全部分类</option>
            {categoriesQuery.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.filter}>
          <label className={styles.filterLabel} htmlFor="filter-location">
            存放位置
          </label>
          <input
            id="filter-location"
            className={styles.control}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="如：冰箱"
          />
        </div>
        <button type="button" className={styles.addBtn} onClick={onAdd}>
          + 添加物品
        </button>
      </div>

      <StatusView
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={!query.isLoading && !query.error && items.length === 0}
        emptyText="暂无物品"
        onRetry={() => void query.refetch()}
      />

      <div className={styles.list}>
        {items.map((item) => (
          <ItemCard key={item.id} item={item} onEdit={onEdit} onDelete={onDelete} />
        ))}
      </div>
    </section>
  );
}
