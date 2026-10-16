/**
 * 监控页：实时 MJPEG 画面 + 采集状态 + 启动/停止控制 + 快照 + 通话录音上传。
 *
 * 设计要点：
 * - 画面：原生 <img src={streamUrl}> 直连后端 multipart/x-mixed-replace 流，不引
 *   入任何流媒体库。加载失败或未启动时按 status.state / configured 显示中文空态。
 * - 状态：useCaptureStatus() 每 2s 轮询，面板展示状态中文映射、fps、最近成帧的
 *   相对时间。
 * - 控制：URL 输入 + 可选 fps 输入 + 启动/停止按钮；mutation pending 时禁用避免重复提交。
 * - 快照：按钮点击刷新一张带时间戳的 <img>（防缓存），独立于实时流。
 * - 通话：原生 MediaRecorder 录音，停止后把 Blob 交给 useTalk().mutate 上传。
 *   方案 A 边界——仅上行留存，手机端回放待后续设备支持，页面显式标注，不伪造实时通话。
 *   无 MediaRecorder / 无麦克风权限时按钮禁用并给出中文提示。
 *
 * 样式用 CSS Modules，跟随现有组件风格；移动端友好（纵向堆叠、控件自适应宽度）。
 */

import { useEffect, useRef, useState } from 'react';
import type { CaptureState, CaptureStatus } from '../api/types';
import { captureApi } from '../api/client';
import {
  useCaptureStatus,
  useStartCapture,
  useStopCapture,
  useTalk,
} from '../hooks/useCapture';
import { StatusView } from './StatusView';
import styles from './MonitorView.module.css';

/** 采集状态中文映射。 */
const STATE_LABEL: Record<CaptureState, string> = {
  idle: '未启动',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  stopped: '已停止',
};

/** 浏览器是否支持 MediaRecorder 录音。 */
const RECORDER_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof window.MediaRecorder !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  navigator.mediaDevices !== undefined;

/** 把毫秒时间戳格式化成「n 秒前 / n 分钟前」相对时间；null 则返回占位。 */
function formatRelative(ts: number | null): string {
  if (ts === null) return '尚无画面';
  const diff = Date.now() - ts;
  if (diff < 1000) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时前`;
}

/** 根据采集状态推导画面区的中文占位文案；返回 null 表示应展示实时画面。 */
function framePlaceholder(status: CaptureStatus | undefined, imgError: boolean): string | null {
  if (!status) return '加载采集状态中…';
  if (!status.configured) return '未配置采集源，请在下方输入地址后启动采集';
  if (status.state === 'idle' || status.state === 'stopped') return '采集未启动';
  if (status.state === 'reconnecting') return '连接中断，正在重连…';
  if (imgError) return '画面加载失败，请检查采集源或稍后重试';
  return null;
}

/** 监控页主体组件。 */
export function MonitorView() {
  const statusQuery = useCaptureStatus();
  const status = statusQuery.data;

  const startMutation = useStartCapture();
  const stopMutation = useStopCapture();
  const talkMutation = useTalk();

  // 控制区输入
  const [url, setUrl] = useState('');
  const [fps, setFps] = useState('');

  // 画面流加载失败标志；状态变化（重新启动）时复位
  const [streamError, setStreamError] = useState(false);
  // 实时流地址仅在启动后固定一次，避免每次 render 重连；null 表示未加载流
  const [streamSrc, setStreamSrc] = useState<string | null>(null);

  // 快照地址（点击快照按钮时刷新）
  const [snapshotSrc, setSnapshotSrc] = useState<string | null>(null);

  // 录音状态与底层 MediaRecorder/流句柄
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // 采集进入可出图状态时加载实时流；回到未启动则卸载流
  const streaming =
    status?.configured === true &&
    (status.state === 'connecting' ||
      status.state === 'connected' ||
      status.state === 'reconnecting');

  useEffect(() => {
    if (streaming) {
      setStreamSrc((prev) => prev ?? captureApi.streamUrl());
    } else {
      setStreamSrc(null);
      setStreamError(false);
    }
  }, [streaming]);

  // 卸载时确保停止仍在进行的录音并释放麦克风
  useEffect(() => {
    return () => {
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      recorder?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function handleStart() {
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    const body: { url: string; fps?: number } = { url: trimmed };
    const fpsNum = Number(fps);
    if (fps.trim() && Number.isFinite(fpsNum) && fpsNum > 0) {
      body.fps = fpsNum;
    }
    setStreamError(false);
    startMutation.mutate(body);
  }

  function handleStop() {
    stopMutation.mutate();
  }

  function handleSnapshot() {
    setSnapshotSrc(captureApi.snapshotUrl());
  }

  /** 开始录音：请求麦克风并启动 MediaRecorder；错误以中文提示呈现。 */
  async function startRecording() {
    if (!RECORDER_SUPPORTED) return;
    setRecordError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });
        chunksRef.current = [];
        if (blob.size > 0) {
          talkMutation.mutate(blob);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecordError('无法访问麦克风，请检查浏览器权限');
    }
  }

  /** 停止录音：触发 onstop 完成上传。 */
  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    setRecording(false);
  }

  const placeholder = framePlaceholder(status, streamError);
  const started = status?.state === 'connecting' || status?.state === 'connected' || status?.state === 'reconnecting';

  return (
    <section className={styles.container}>
      {/* 画面区 */}
      <div className={styles.screen}>
        {streamSrc && !streamError ? (
          <img
            className={styles.frame}
            src={streamSrc}
            alt="实时监控画面"
            onError={() => setStreamError(true)}
          />
        ) : (
          <div className={styles.placeholder}>{placeholder ?? '采集未启动'}</div>
        )}
      </div>

      {/* 采集状态面板 */}
      <div className={styles.panel}>
        <StatusView
          isLoading={statusQuery.isLoading}
          error={statusQuery.error}
          onRetry={() => void statusQuery.refetch()}
        />
        {status && (
          <dl className={styles.statusGrid}>
            <dt>状态</dt>
            <dd>{STATE_LABEL[status.state]}</dd>
            <dt>帧率</dt>
            <dd>{status.fps} fps</dd>
            <dt>最近成帧</dt>
            <dd>{formatRelative(status.lastFrameAt)}</dd>
            <dt>累计帧数</dt>
            <dd>{status.frameCount}</dd>
            <dt>重连次数</dt>
            <dd>{status.reconnectAttempts}</dd>
          </dl>
        )}
      </div>

      {/* 控制区：URL + fps + 启动/停止 */}
      <div className={styles.controls}>
        <label className={styles.label} htmlFor="capture-url">
          采集源地址
        </label>
        <input
          id="capture-url"
          className={styles.input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://手机IP:8080/video 或 rtsp://手机IP:8080/..."
          inputMode="url"
          autoComplete="off"
        />
        <label className={styles.label} htmlFor="capture-fps">
          抽帧帧率（可选）
        </label>
        <input
          id="capture-fps"
          className={styles.input}
          value={fps}
          onChange={(e) => setFps(e.target.value)}
          placeholder="如：5"
          inputMode="numeric"
        />
        <div className={styles.btnRow}>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary}`}
            onClick={handleStart}
            disabled={startMutation.isPending || !url.trim()}
          >
            {startMutation.isPending ? '启动中…' : '启动采集'}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={handleStop}
            disabled={stopMutation.isPending || !started}
          >
            {stopMutation.isPending ? '停止中…' : '停止采集'}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={handleSnapshot}
            disabled={!status?.configured}
          >
            快照
          </button>
        </div>
        {startMutation.error && (
          <p className={styles.hintError}>
            启动失败：{(startMutation.error as Error).message}
          </p>
        )}
      </div>

      {/* 快照展示 */}
      {snapshotSrc && (
        <div className={styles.snapshot}>
          <div className={styles.sectionTitle}>最近快照</div>
          <img className={styles.frame} src={snapshotSrc} alt="采集快照" />
        </div>
      )}

      {/* 通话录音区（方案 A：仅上行留存） */}
      <div className={styles.talk}>
        <div className={styles.sectionTitle}>通话（上行留存）</div>
        <p className={styles.note}>
          方案 A：录音仅上行留存至服务器，手机端回放待后续设备支持。
        </p>
        {!RECORDER_SUPPORTED && (
          <p className={styles.hintError}>当前浏览器不支持录音（MediaRecorder）。</p>
        )}
        <div className={styles.btnRow}>
          {recording ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.danger}`}
              onClick={stopRecording}
            >
              停止录音并上传
            </button>
          ) : (
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={() => void startRecording()}
              disabled={!RECORDER_SUPPORTED || talkMutation.isPending}
            >
              {talkMutation.isPending ? '上传中…' : '开始录音'}
            </button>
          )}
        </div>
        {recordError && <p className={styles.hintError}>{recordError}</p>}
        {talkMutation.isSuccess && (
          <p className={styles.hintOk}>
            已上传 {talkMutation.data.bytes} 字节。{talkMutation.data.note}
          </p>
        )}
        {talkMutation.error && (
          <p className={styles.hintError}>
            上传失败：{(talkMutation.error as Error).message}
          </p>
        )}
      </div>
    </section>
  );
}
