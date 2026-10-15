/**
 * 采集网关路由（Fastify 插件）。
 *
 * 通过 opts 注入网关持有者（gateway holder），对外提供四个端点：
 * - GET  /api/capture/status   — 返回当前状态指标 + configured（源是否已配置）
 * - POST /api/capture/start    — 校验 body { url, fps? } 后切换源并启动采集
 * - POST /api/capture/stop     — 停止采集
 * - GET  /api/capture/snapshot — 返回最近一帧 JPEG（无帧则 503）
 *
 * 错误体统一为 { error: { message, code? } }，与现有路由（ai.ts / voice.ts）一致。
 *
 * 关于源切换：FEAT-001 的网关实例把 sourceUrl 固化在工厂闭包里，不支持运行时
 * 改源。故这里注入的不是裸 CaptureGateway，而是一个「持有者」——它实现了
 * CaptureGateway 的全部方法，并额外提供 setSource(url, fps?)：收到带新 URL 的
 * /start 时先停旧实例再用新 options 重建，从而满足 /start 可切换采集源的需求。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';

import {
  createCaptureGateway,
  type CaptureGateway,
  type CaptureGatewayOptions,
} from '../capture/gateway.js';

/**
 * 网关持有者：在 CaptureGateway 之上增加 setSource，用于运行时切换采集源。
 * 由 app.ts 构造并注入；路由只依赖此接口，不关心重建细节。
 */
export interface CaptureGatewayHolder extends CaptureGateway {
  /**
   * 设置采集源（并按需重建底层网关实例）。
   * @param url 新的采集源地址
   * @param fps 可选抽帧帧率；省略则沿用默认配置
   */
  setSource(url: string, fps?: number): void;
}

/**
 * 构造一个网关持有者：内部持有「当前底层网关实例 + 其构造 options」。
 *
 * FEAT-001 的网关实例不支持运行时改源（sourceUrl 固化在工厂闭包）。故持有者在
 * setSource 收到新 URL（或新 fps）时：若与当前实例配置不同，则先对旧实例尽力
 * stop（不阻塞当前调用、吞掉停止异常），再用新 options 调 createCaptureGateway
 * 重建；URL/fps 不变则复用现有实例（start 本身幂等）。其余方法转发给当前实例。
 *
 * @param baseOptions 初始网关 options（通常来自 loadCaptureConfig()）；不自动 start。
 */
export function createCaptureGatewayHolder(
  baseOptions: CaptureGatewayOptions,
): CaptureGatewayHolder {
  // 当前底层网关实例与其构造 options（随 setSource 一起更新）
  let currentOptions: CaptureGatewayOptions = baseOptions;
  let gateway: CaptureGateway = createCaptureGateway(currentOptions);

  return {
    setSource(url: string, fps?: number): void {
      const nextFps = fps ?? baseOptions.fps;
      // 源与帧率都未变化：无需重建，直接复用现有实例
      if (url === currentOptions.sourceUrl && nextFps === currentOptions.fps) {
        return;
      }
      // 配置变化：尽力停掉旧实例（异常只吞掉，不阻塞改源），再用新 options 重建
      void gateway.stop().catch(() => {});
      currentOptions = { ...baseOptions, sourceUrl: url, fps: nextFps };
      gateway = createCaptureGateway(currentOptions);
    },
    start(): void {
      gateway.start();
    },
    stop(): Promise<void> {
      return gateway.stop();
    },
    getStatus() {
      return gateway.getStatus();
    },
    getLatestFrame(): Buffer | null {
      return gateway.getLatestFrame();
    },
  };
}

/** 路由插件 opts：注入网关持有者。 */
export interface CaptureRoutesOptions extends FastifyPluginOptions {
  gateway: CaptureGatewayHolder;
}

/** POST /api/capture/start 请求体校验：url 必填且为合法 URL，fps 可选正数。 */
const startBodySchema = z.object({
  /** 采集源地址：必须是合法 URL（http/rtsp 等由 ffmpeg 处理） */
  url: z.string().url(),
  /** 抽帧帧率：可选正数，省略则沿用默认配置 */
  fps: z.number().positive().optional(),
});

/** 注册采集网关路由。 */
export async function captureRoutes(
  app: FastifyInstance,
  opts: CaptureRoutesOptions,
): Promise<void> {
  const { gateway } = opts;

  // GET /api/capture/status — 当前状态 + 是否已配置源（sourceUrl 非空）
  app.get('/api/capture/status', async () => {
    const status = gateway.getStatus();
    return { ...status, configured: status.sourceUrl !== '' };
  });

  // POST /api/capture/start — 校验 body 后切换源并启动；body 校验失败抛 ZodError 由 app 统一转 400
  app.post('/api/capture/start', async (request) => {
    const { url, fps } = startBodySchema.parse(request.body);
    // 带新 URL 的 start：先切换源（必要时重建底层实例），再启动（start 幂等）
    gateway.setSource(url, fps);
    gateway.start();
    return gateway.getStatus();
  });

  // POST /api/capture/stop — 停止采集并返回最新状态
  app.post('/api/capture/stop', async () => {
    await gateway.stop();
    return gateway.getStatus();
  });

  // GET /api/capture/snapshot — 返回最近一帧 JPEG；无帧则 503 NO_FRAME
  app.get('/api/capture/snapshot', async (_request, reply) => {
    const frame = gateway.getLatestFrame();
    if (frame === null) {
      return reply.code(503).send({
        error: { message: '暂无可用帧', code: 'NO_FRAME' },
      });
    }
    return reply.type('image/jpeg').send(frame);
  });
}
