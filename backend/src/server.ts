/**
 * HTTP 服务器入口。
 *
 * 用 buildApp() 构建应用并 listen：
 * - 启动前确保数据库表存在（initSchema）；
 * - 端口从 SMARTBUTLER_PORT 读取，默认 3000；host 0.0.0.0；
 * - 仅在作为脚本直接执行时启动（被 import 时不触发）。
 */

import { buildApp } from './app.js';
import { sqlite } from './db/client.js';
import { initSchema } from './db/init.js';

/** 启动服务器 */
async function start(): Promise<void> {
  // 确保表存在（幂等）
  initSchema(sqlite);

  const app = buildApp();
  const port = Number(process.env.SMARTBUTLER_PORT ?? 3000);
  const host = '0.0.0.0';

  await app.listen({ port, host });
  console.log(`[server] SmartButler 后端已启动：http://${host}:${port}`);
}

// 仅在作为脚本直接执行时启动
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('[server] 启动失败：', err);
    process.exit(1);
  });
}
