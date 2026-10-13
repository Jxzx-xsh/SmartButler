import styles from './StatusView.module.css';

interface StatusViewProps {
  isLoading?: boolean;
  error?: unknown;
  isEmpty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
}

/** 从未知错误里提取中文可读信息。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '未知错误';
}

/** 通用加载 / 错误 / 空态展示，避免白屏。 */
export function StatusView({
  isLoading,
  error,
  isEmpty,
  emptyText = '暂无数据',
  onRetry,
}: StatusViewProps) {
  if (isLoading) {
    return <div className={styles.status}>加载中…</div>;
  }
  if (error) {
    return (
      <div className={`${styles.status} ${styles.error}`}>
        <p>出错了：{errorMessage(error)}</p>
        {onRetry && (
          <button type="button" className={styles.retry} onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return <div className={styles.status}>{emptyText}</div>;
  }
  return null;
}
