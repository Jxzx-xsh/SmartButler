import type { CreateItemBody, Item } from '../api/types';
import { useCreateItem, useUpdateItem } from '../hooks/useItems';
import { ItemForm } from './ItemForm';
import styles from './ItemFormModal.module.css';

interface ItemFormModalProps {
  /** 传入物品为编辑模式，否则为新建模式。 */
  item?: Item;
  onClose: () => void;
}

/** 提取 mutation 错误的中文信息。 */
function errorText(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  return undefined;
}

/** 包裹 ItemForm 的模态框，负责调用创建 / 更新 mutation。 */
export function ItemFormModal({ item, onClose }: ItemFormModalProps) {
  const isEdit = item !== undefined;
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();

  function handleSubmit(body: CreateItemBody) {
    if (isEdit && item) {
      updateItem.mutate({ id: item.id, body }, { onSuccess: onClose });
    } else {
      createItem.mutate(body, { onSuccess: onClose });
    }
  }

  const submitting = createItem.isPending || updateItem.isPending;
  const error = errorText(createItem.error ?? updateItem.error);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>{isEdit ? '编辑物品' : '添加物品'}</h2>
        <ItemForm
          initialItem={item}
          submitting={submitting}
          errorText={error}
          onSubmit={handleSubmit}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}
