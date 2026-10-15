/**
 * 门控路由（Fastify 插件）。
 *
 * 通过 opts 注入门控协调器（GatingController），对外提供：
 * - GET /api/gating/status — 返回门控运行指标（getStats()）并补一个 active 字段，
 *   表示「当前是否处于活动中」（正在说话，或最近一次运动事件落在近窗口内）。
 *
 * 错误体统一为 { error: { message, code? } }，与现有路由（capture.ts / ai.ts）一致。
 *
 * 关于 POST /api/gating/config：FEAT-002 的 GatingController 不暴露 setConfig /
 * updateThresholds，阈值在构造 motionDetector/vad 时固定、不支持运行时热更新
 * （见 FEAT-002 findings）。运行时改阈值须重建检测器，超出本路由职责，故本
 * FEAT 只实现 status；此处显式说明，不提供 config 端点。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { GatingController } from '../gating/gating.js';

/**
 * 判定「活动中」时，最近一次运动事件距今的最大毫秒数。
 * 落在此窗口内视为仍在活动（画面近期有明显变动）。
 */
const ACTIVE_MOTION_WINDOW_MS = 3000;

/** 路由插件 opts：注入门控协调器。 */
export interface GatingRoutesOptions extends FastifyPluginOptions {
  controller: GatingController;
}

/** 注册门控路由。 */
export async function gatingRoutes(
  app: FastifyInstance,
  opts: GatingRoutesOptions,
): Promise<void> {
  const { controller } = opts;

  // GET /api/gating/status — 返回门控统计 + active（是否正在活动中）
  app.get('/api/gating/status', async () => {
    const stats = controller.getStats();
    // active：正在说话，或最近运动事件落在近窗口内（lastMotionAt 距今 < 窗口）
    const recentMotion =
      stats.lastMotionAt !== null &&
      Date.now() - stats.lastMotionAt < ACTIVE_MOTION_WINDOW_MS;
    const active = stats.speaking || recentMotion;
    return { ...stats, active };
  });
}
