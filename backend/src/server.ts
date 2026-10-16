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
import { createFrameBroadcaster } from './capture/frame-broadcaster.js';
import { eventLogs } from './db/schema.js';
import { createLmStudioClient } from './ai/lmstudio.js';
import { createVisionParser } from './ai/vision-parser.js';
import { createVisionIngest } from './capture/vision-ingest.js';

/** 启动服务器 */
async function start(): Promise<void> {
  // 确保表存在（幂等）
  initSchema(sqlite);

  // 门控协调器：先构造，再把其 processFrame/processAudio 接到网关回调。
  const gatingController = createDefaultGatingController();

  // AI 任务队列（空闲批处理定时器）：供视觉识别走 enqueueDeferred 延后批处理。
  // 先构造以便视觉入库管线复用，start/stop 在 app 构建后挂到 onClose。
  const aiQueue = createAiQueue({ db });

  // 视觉入库管线：同一 db + 一个 LM Studio 客户端 + aiQueue 构造识别器。
  // 识别任务经 visionParser 内部的 enqueueDeferred 串行化、空闲批处理，不阻塞门控/网关。
  const visionParser = createVisionParser({
    client: createLmStudioClient(),
    queue: aiQueue,
  });
  const visionIngest = createVisionIngest({ db, visionParser });

  // 订阅门控事件：可观测（日志 + 落库 eventLogs source='gating'），落库失败吞掉不影响主流程，
  // 容错写法对齐 src/ai/queue.ts 的 emit()。此外把运动帧接到视觉入库管线（容错、不阻塞门控）。
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

    // 把触发帧接到视觉入库管线：异步容错，绝不 throw 回门控链、不阻塞门控/网关。
    // 识别经 aiQueue.enqueueDeferred（在 visionParser 内部）串行化、空闲批处理。
    visionIngest
      .ingestFrame(event.frame, event.timestamp)
      .then((items) => {
        if (items.length > 0) {
          console.log(`[vision] 识别入库 ${items.length} 项`);
        }
      })
      .catch((err) => {
        console.error('[vision] 识别入库失败（不影响门控）：', err);
        try {
          db.insert(eventLogs)
            .values({
              eventType: 'vision_error',
              payload: JSON.stringify({
                message: err instanceof Error ? err.message : String(err),
              }),
              source: 'vision',
            })
            .run();
        } catch {
          // 事件日志落库失败不影响主流程
        }
      });
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

  // 帧广播器：作为网关唯一 onFrame 的落点，再 fan-out 给门控与 stream 订阅者。
  const broadcaster = createFrameBroadcaster();

  // 采集网关持有者：把门控 processFrame + 广播器 publish 作为 onFrame 注入
  // baseOptions（先门控后广播，保证门控仍收到每帧且行为零变化）；onAudio 保持
  // 原样直连门控。经 FEAT-002 的回调透传，setSource 重建底层网关后仍生效。
  const captureConfig = loadCaptureConfig();
  const captureGateway = createCaptureGatewayHolder({
    ...captureConfig,
    onFrame: (buffer, timestamp) => {
      gatingController.processFrame(buffer, timestamp);
      broadcaster.publish(buffer, timestamp);
    },
    onAudio: (pcmChunk, timestamp) => gatingController.processAudio(pcmChunk, timestamp),
  });

  // 同一门控实例 + 视觉入库管线 + 帧广播器注入 app（供路由/状态读取与接线）
  const app = buildApp({
    captureGateway,
    gatingController,
    visionIngest,
    frameBroadcaster: broadcaster,
  });

  // 启动 AI 任务队列（空闲批处理定时器），进程关闭时停止
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
