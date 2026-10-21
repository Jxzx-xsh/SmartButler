import { useState } from 'react';
import type { FormEvent } from 'react';
import { login } from '../api/client';
import styles from './LoginGate.module.css';

interface LoginGateProps {
  /** 登录成功回调（由顶层切换到主界面）。 */
  onSuccess: () => void;
}

/** 提取登录错误的中文信息。 */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '登录失败，请重试';
}

/** 全屏登录遮罩：受控密码输入 + 登录，蓝青视觉，未登录时替代主界面。 */
export function LoginGate({ onSuccess }: LoginGateProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(undefined);
    setSubmitting(true);
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.brand}>SmartButler</div>
        <p className={styles.hint}>请输入访问密码以继续</p>

        <input
          className={styles.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="访问密码"
          autoComplete="current-password"
          disabled={submitting}
        />

        {error && <p className={styles.error}>{error}</p>}

        <button className={styles.button} type="submit" disabled={submitting}>
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
