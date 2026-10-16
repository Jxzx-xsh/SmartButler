/**
 * Fastify 应用工厂。
 *
 * buildApp(options?) 返回配置好的 Fastify 实例：
 * - 支持注入数据库实例（默认用 client.ts 的 db，测试时可传独立内存库）；
 * - 注册 @fastify/cors（后续 PWA 跨域需要）；
 * - 注册物品 / 分类路由；
 * - 统一错误处理：ZodError → 400，其余按状态码或 500，错误体统一为 { error: { message, code? } }。
 *
 * 同步构建、返回 FastifyInstance，便于测试用 inject() 调用，无需真实监听端口。
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';

import { db as defaultDb, type AppDatabase } from './db/client.js';
import { itemsRoutes } from './routes/items.js';
import { categoriesRoutes } from './routes/categories.js';
import { aiRoutes } from './routes/ai.js';
import { voiceRoutes } from './routes/voice.js';
import { visionRoutes } from './routes/vision.js';
import type { VisionIngest } from './capture/vision-ingest.js';
import type { FrameBroadcaster } from './capture/frame-broadcaster.js';
import { createLmStudioClient, type LmStudioClient } from './ai/lmstudio.js';
import { createWhisperTranscriber, type WhisperTranscriber } from './ai/whisper.js';
import { createIntentClassifier } from './ai/intent-classifier.js';
import { createItemParser } from './ai/item-parser.js';
import { createCommandRouter, type CommandRouter } from './commands/command-router.js';
import { commandRoutes } from './routes/command.js';
import {
  captureRoutes,
  createCaptureGatewayHolder,
  type CaptureGatewayHolder,
} from './routes/capture.js';
import { loadCaptureConfig } from './capture/config.js';
import { gatingRoutes } from './routes/gating.js';
import { loadHaConfig } from './ha/config.js';
import { createHaClient, type HaClient } from './ha/ha-client.js';
import { haRoutes } from './routes/ha.js';
import type { HaEventSubscriber } from './ha/ha-events.js';
import { createGatingController, type GatingController } from './gating/gating.js';
import { createMotionDetector } from './gating/motion.js';
import { createVad } from './gating/vad.js';
import { loadGatingConfig } from './gating/config.js';

/** buildApp 选项 */
export interface BuildAppOptions {
  /** 注入的数据库实例，缺省使用 client.ts 的默认 db */
  db?: AppDatabase;
  /** 注入的 LM Studio 客户端，缺省调用 createLmStudioClient() */
  aiClient?: LmStudioClient;
  /** 注入的 whisper.cpp 转写器，缺省调用 createWhisperTranscriber() */
  transcriber?: WhisperTranscriber;
  /**
   * 注入的采集网关持有者，缺省基于 loadCaptureConfig() 构造且不自动 start。
   * server.ts 需在源非空时自动启动，故由其构造同一实例注入进来。
   */
  captureGateway?: CaptureGatewayHolder;
  /**
   * 注入的门控协调器，缺省基于 loadGatingConfig() 构造 motionDetector/vad 后组合。
   * server.ts 需把门控接到网关 onFrame/onAudio，故由其构造同一实例注入进来。
   */
  gatingController?: GatingController;
  /**
   * 注入的视觉入库管线，供测试直接注入 mock；缺省时由 vision 路由现场构造
   * （同步直调识别器，不走队列）。server.ts 走 deferred 队列，故由其构造注入。
   */
  visionIngest?: VisionIngest;
  /**
   * 注入的帧广播器，供 GET /api/capture/stream 订阅下发 MJPEG 帧。缺省不注入
   * （stream 端点退化为仅下发最新帧）；server.ts 构造真实实例并接到网关 onFrame。
   */
  frameBroadcaster?: FrameBroadcaster;
  /**
   * 注入的通话上行留存回调，供 POST /api/capture/talk 持久化录音。缺省不注入
   * （talk 端点仍正常返回，仅不留存）；server.ts 实现为落 eventLogs(source='talk')
   * + 写临时文件 data/talk/。
   */
  talkSink?: (
    buffer: Buffer,
    meta: { timestamp: number; mimetype?: string },
  ) => Promise<void> | void;
  /**
   * 注入的 HA REST 客户端，缺省基于 loadHaConfig() 现场构造（不触网）。
   * server.ts 构造同一实例注入，供 /api/ha/* 读/控使用。
   */
  haClient?: HaClient;
  /**
   * 注入的 HA WS 事件订阅器，缺省不注入（/api/ha/status 的 connected 退化为 false）。
   * server.ts 仅在 HA 已配置时构造并注入，供状态端点读取连接态。
   */
  haSubscriber?: HaEventSubscriber;
  /**
   * 注入的指令路由器，缺省基于已构造的 db/aiClient/haClient/haConfig 现场构造
   * （不走队列）。server.ts 走 aiQueue 的即时队列，故由其构造同一实例注入。
   */
  commandRouter?: CommandRouter;
}

/**
 * 基于 loadGatingConfig() 构造一个缺省门控协调器：读取门控配置，分别建移动
 * 侦测器与 VAD，再组合成 GatingController。供 buildApp 缺省与 server.ts 复用。
 */
export function createDefaultGatingController(
  env: NodeJS.ProcessEnv = process.env,
): GatingController {
  const config = loadGatingConfig(env);
  const motionDetector = createMotionDetector({
    threshold: config.motionThreshold,
    thumbWidth: config.motionThumbWidth,
    thumbHeight: config.motionThumbHeight,
    perPixelDelta: config.motionPerPixelDelta,
    cooldownMs: config.motionCooldownMs,
    minConsecutiveFrames: config.motionMinConsecutiveFrames,
  });
  const vad = createVad({
    energyThreshold: config.vadEnergyThreshold,
    frameMs: config.vadFrameMs,
    triggerMs: config.vadTriggerMs,
    hangoverMs: config.vadHangoverMs,
    minEventMs: config.vadMinEventMs,
    cooldownMs: config.vadCooldownMs,
  });
  return createGatingController({ motionDetector, vad });
}

/** 把 zod 的 issues 概要成一句可读信息 */
function summarizeZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** 构建并返回配置好的 Fastify 实例 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const db = options.db ?? defaultDb;

  const app = Fastify({ logger: false });
  // LM Studio 客户端：ai 与 voice 路由共用同一实例
  const aiClient = options.aiClient ?? createLmStudioClient();
  // 本地 whisper.cpp 转写器：voice 路由语音转写由它承担
  const transcriber = options.transcriber ?? createWhisperTranscriber();
  // 采集网关持有者：缺省基于 loadCaptureConfig() 构造（不自动 start，由 server 决定）
  const captureGateway =
    options.captureGateway ?? createCaptureGatewayHolder(loadCaptureConfig());
  // 门控协调器：缺省基于 loadGatingConfig() 构造检测器后组合（接线由 server 决定）
  const gatingController =
    options.gatingController ?? createDefaultGatingController();

  // CORS：开放所有来源（局域网内 PWA / 采集端访问）
  app.register(cors, { origin: true });
  // multipart：语音入库端点接收上传音频，限制单文件 25MB
  app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });

  // 注入 db 注册业务路由
  app.register(itemsRoutes, { db });
  app.register(categoriesRoutes, { db });
  // 注入 LM Studio 客户端注册 AI 路由
  app.register(aiRoutes, { client: aiClient });
  // 注入 db + LM Studio 客户端 + whisper 转写器注册语音入库路由
  app.register(voiceRoutes, { db, client: aiClient, transcriber });
  // 注入 db + LM Studio 客户端注册视觉入库路由（可注入 visionIngest 便于测试/接线）
  app.register(visionRoutes, {
    db,
    client: aiClient,
    ...(options.visionIngest ? { visionIngest: options.visionIngest } : {}),
  });
  // 注入采集网关持有者注册采集路由（存在帧广播器才条件透传，沿用 visionIngest 写法）
  app.register(captureRoutes, {
    gateway: captureGateway,
    ...(options.frameBroadcaster
      ? { broadcaster: options.frameBroadcaster }
      : {}),
    ...(options.talkSink ? { talkSink: options.talkSink } : {}),
  });
  // 注入门控协调器注册门控路由
  app.register(gatingRoutes, { controller: gatingController });
  // HA 集成路由：读配置 + 缺省现场构造 client（不触网），路由内部按 isHaConfigured 降级；
  // 未配置 HA 也注册（端点自行 503/降级），存在 subscriber 才条件透传（沿用上面写法）
  const haConfig = loadHaConfig();
  const haClient = options.haClient ?? createHaClient({ config: haConfig });
  app.register(haRoutes, {
    client: haClient,
    db,
    config: haConfig,
    ...(options.haSubscriber ? { subscriber: options.haSubscriber } : {}),
  });

  // 指令路由：缺省现场构造意图分类器 + 物品解析器（与 voice 一致，不走队列），
  // 组合为 commandRouter；server.ts 走 aiQueue 的即时队列，故可注入同一实例。
  const commandRouter =
    options.commandRouter ??
    createCommandRouter({
      db,
      classifier: createIntentClassifier({ client: aiClient }),
      itemParser: createItemParser({ client: aiClient }),
      haClient,
      haConfig,
    });
  app.register(commandRoutes, { router: commandRouter });

  // 统一错误处理（error 由 Fastify 保证为 FastifyError，含 message/code/statusCode）
  app.setErrorHandler(
    (error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
      // zod 校验失败 → 400
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: {
            message: summarizeZodError(error),
            code: 'VALIDATION_ERROR',
          },
        });
      }

      // Fastify 内置 body 解析/校验错误（含 statusCode）透传
      const statusCode = error.statusCode;
      if (
        typeof statusCode === 'number' &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
        return reply.code(statusCode).send({
          error: { message: error.message, code: error.code },
        });
      }

      // 其余按 500 处理
      app.log.error(error);
      return reply.code(500).send({
        error: { message: '服务器内部错误' },
      });
    },
  );

  return app;
}
