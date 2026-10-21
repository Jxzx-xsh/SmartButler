import { createPortal } from 'react-dom';
import styles from './StatusView.module.css';

interface StatusViewProps {
  isLoading?: boolean;
  error?: unknown;
  isEmpty?: boolean;
  emptyText?: string;
  onRetry?: () => void;
  /** 为 true 时全屏遮罩展示 loading / 错误，覆盖 header/tabbar。用于首屏数据加载。
   *  使用 React Portal 渲染到 document.body，彻底脱离 .app 的 max-width/flex 等约束。 */
  fullscreen?: boolean;
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
  fullscreen,
}: StatusViewProps) {
  if (isLoading) {
    const node = (
      <div
        className={`${styles.status} ${fullscreen ? styles.fullscreen : ''}`}
      >
        <span className={styles.spinner} aria-hidden="true" />
        <span className={styles.statusText}>加载中…</span>
      </div>
    );
    return fullscreen ? createPortal(node, document.body) : node;
  }
  if (error) {
    const node = (
      <div
        className={`${styles.status} ${styles.error} ${fullscreen ? styles.fullscreen : ''}`}
      >
        <p>出错了：{errorMessage(error)}</p>
        {onRetry && (
          <button type="button" className={styles.retry} onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    );
    return fullscreen ? createPortal(node, document.body) : node;
  }
  if (isEmpty) {
    return <div className={styles.status}>{emptyText}</div>;
  }
  return null;
}
