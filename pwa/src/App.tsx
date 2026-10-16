import { useState } from 'react';
import type { Item } from './api/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ExpiryBoard } from './components/ExpiryBoard';
import { ItemFormModal } from './components/ItemFormModal';
import { ItemList } from './components/ItemList';
import { MonitorView } from './components/MonitorView';
import { useDeleteItem } from './hooks/useItems';
import styles from './App.module.css';

type Tab = 'board' | 'all' | 'monitor';

/** 顶层布局：标题 + 标签切换（到期看板 / 全部物品），统筹编辑与删除交互。 */
export default function App() {
  const [tab, setTab] = useState<Tab>('board');

  // 表单模态：undefined=关闭，null=新建，Item=编辑
  const [formTarget, setFormTarget] = useState<Item | null | undefined>(undefined);
  // 删除确认目标
  const [deleteTarget, setDeleteTarget] = useState<Item | undefined>(undefined);

  const deleteItem = useDeleteItem();

  function handleEdit(item: Item) {
    setFormTarget(item);
  }

  function handleDelete(item: Item) {
    setDeleteTarget(item);
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    deleteItem.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(undefined),
    });
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.title}>SmartButler 家庭管家</div>
        <p className={styles.subtitle}>食材到期提醒与物品管理</p>
      </header>

      <nav className={styles.tabbar}>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'board' ? styles.tabActive : ''}`}
          onClick={() => setTab('board')}
        >
          到期看板
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'all' ? styles.tabActive : ''}`}
          onClick={() => setTab('all')}
        >
          全部物品
        </button>
        <button
          type="button"
          className={`${styles.tab} ${tab === 'monitor' ? styles.tabActive : ''}`}
          onClick={() => setTab('monitor')}
        >
          监控
        </button>
      </nav>

      <main className={styles.main}>
        {tab === 'board' && (
          <ExpiryBoard onEdit={handleEdit} onDelete={handleDelete} />
        )}
        {tab === 'all' && (
          <ItemList
            onAdd={() => setFormTarget(null)}
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
        {tab === 'monitor' && <MonitorView />}
      </main>

      {formTarget !== undefined && (
        <ItemFormModal
          item={formTarget ?? undefined}
          onClose={() => setFormTarget(undefined)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除物品"
          content={`确定删除「${deleteTarget.name}」吗？此操作不可撤销。`}
          confirmText="删除"
          busy={deleteItem.isPending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(undefined)}
        />
      )}
    </div>
  );
}
