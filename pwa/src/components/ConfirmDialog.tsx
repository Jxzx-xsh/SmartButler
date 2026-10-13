import styles from './ConfirmDialog.module.css';

interface ConfirmDialogProps {
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 二次确认对话框（用于删除等破坏性操作）。 */
export function ConfirmDialog({
  title,
  content,
  confirmText = '确认',
  cancelText = '取消',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.content}>{content}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.danger}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
