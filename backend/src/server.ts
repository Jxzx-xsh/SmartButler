/**
 * HTTP 服务器入口。
 *
 * 用 buildApp() 构建应用并 listen：
 * - 启动前确保数据库表存在（initSchema）；
 * - 端口从 SMARTBUTLER_PORT 读取，默认 3000；host 0.0.0.0；
 * - 仅在作为脚本直接执行时启动（被 import 时不触发）。
 */

import { buildApp } from './app.js';
import { db, sqlite } from './db/client.js';
import { initSchema } from './db/init.js';
import { createAiQueue } from './ai/queue.js';
import { createCaptureGatewayHolder } from './routes/capture.js';
import { loadCaptureConfig } from './capture/config.js';

/** 启动服务器 */
async function start(): Promise<void> {
  // 确保表存在（幂等）
  initSchema(sqlite);

  // 采集网关持有者：构造同一实例并注入 app，启动后按配置决定是否自动采集
  const captureConfig = loadCaptureConfig();
  const captureGateway = createCaptureGatewayHolder(captureConfig);

  const app = buildApp({ captureGateway });

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
