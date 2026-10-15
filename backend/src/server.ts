/**
 * HTTP 服务器入口。
 *
 * 用 buildApp() 构建应用并 listen：
 * - 启动前确保数据库表存在（initSchema）；
 * - 端口从 SMARTBUTLER_PORT 读取，默认 3000；host 0.0.0.0；
 * - 仅在作为脚本直接执行时启动（被 import 时不触发）。
 */

import { buildApp, createDefaultGatingController } from './app.js';
import { db, sqlite } from './db/client.js';
import { initSchema } from './db/init.js';
import { createAiQueue } from './ai/queue.js';
import { createCaptureGatewayHolder } from './routes/capture.js';
import { loadCaptureConfig } from './capture/config.js';
import { eventLogs } from './db/schema.js';

/** 启动服务器 */
async function start(): Promise<void> {
  // 确保表存在（幂等）
  initSchema(sqlite);

  // 门控协调器：先构造，再把其 processFrame/processAudio 接到网关回调。
  const gatingController = createDefaultGatingController();

  // 订阅门控事件：目前只做可观测（日志 + 可选落库 eventLogs source='gating'），
  // 不强制接 AI 队列（留给上层 Task8/Task5 消费）。落库失败吞掉不影响主流程，
  // 容错写法对齐 src/ai/queue.ts 的 emit()。
  gatingController.onVideoMotion((event) => {
    console.log(
      `[gating] 运动事件 ts=${event.timestamp} changedRatio=${event.changedRatio.toFixed(3)}`,
    );
    try {
      db.insert(eventLogs)
        .values({
          eventType: 'gating_motion',
          payload: JSON.stringify({
            timestamp: event.timestamp,
            changedRatio: event.changedRatio,
          }),
          source: 'gating',
        })
        .run();
    } catch {
      // 事件日志落库失败不影响主流程
    }
  });
  gatingController.onAudioActivity((event) => {
    console.log(
      `[gating] 音频活动事件 start=${event.startTimestamp} end=${event.endTimestamp} dur=${event.durationMs}ms`,
    );
    try {
      db.insert(eventLogs)
        .values({
          eventType: 'gating_audio',
          payload: JSON.stringify({
            startTimestamp: event.startTimestamp,
            endTimestamp: event.endTimestamp,
            durationMs: event.durationMs,
            frameCount: event.frameCount,
          }),
          source: 'gating',
        })
        .run();
    } catch {
      // 事件日志落库失败不影响主流程
    }
  });

  // 采集网关持有者：把门控 processFrame/processAudio 作为 onFrame/onAudio 注入
  // baseOptions。经 FEAT-002 的回调透传，setSource 重建底层网关后仍生效。
  const captureConfig = loadCaptureConfig();
  const captureGateway = createCaptureGatewayHolder({
    ...captureConfig,
    onFrame: (buffer, timestamp) => gatingController.processFrame(buffer, timestamp),
    onAudio: (pcmChunk, timestamp) => gatingController.processAudio(pcmChunk, timestamp),
  });

  // 同一门控实例注入 app（供 GET /api/gating/status 读取统计）
  const app = buildApp({ captureGateway, gatingController });

  // 构建并启动 AI 任务队列（空闲批处理定时器），进程关闭时停止
  const aiQueue = createAiQueue({ db });
  aiQueue.start();
  app.addHook('onClose', async () => {
    aiQueue.stop();
  });

  // 进程关闭时停止采集网关（等待子进程退出，避免僵尸进程）
  app.addHook('onClose', async () => {
    await captureGateway.stop();
  });

  const port = Number(process.env.SMARTBUTLER_PORT ?? 3000);
  const host = '0.0.0.0';

  await app.listen({ port, host });
  console.log(`[server] SmartButler 后端已启动：http://${host}:${port}`);

  // 配置了采集源才自动启动；启动失败只记日志，绝不阻塞/中断后端进程
  if (captureConfig.sourceUrl !== '') {
    try {
      captureGateway.start();
      console.log(`[server] 采集网关已自动启动：${captureConfig.sourceUrl}`);
    } catch (err) {
      console.error('[server] 采集网关自动启动失败（后端继续运行）：', err);
    }
  }
}

// 仅在作为脚本直接执行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('[server] 启动失败：', err);
    process.exit(1);
  });
}
