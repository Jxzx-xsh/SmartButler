/**
 * 视觉入库路由（Fastify 插件）。
 *
 * 打通「图片帧 → 视觉识别 → 入库」渠道，提供两个端点：
 * - POST /api/vision/ingest-frame：接收一帧图片（multipart 文件或 base64 body）
 *   → 经视觉入库管线识别并入库 → 返回入库物品（source='vision'、confirmed=false）。
 * - GET /api/vision/status：返回入库统计（lastIngestAt / ingestedCount）。
 *
 * 依赖通过 opts 注入：db、client（LM Studio 客户端）、queue（可选 AI 队列）、
 * visionIngest（可选，便于测试直接注入 mock）。缺省时用 createVisionParser +
 * createVisionIngest 现场构造；缺 queue 时视觉识别同步直调（server.ts 走 deferred 队列）。
 *
 * 错误体统一为 { error: { message, code } }，与现有路由风格一致。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import type { LmStudioClient } from '../ai/lmstudio.js';
import type { AiQueue } from '../ai/queue.js';
import { createVisionParser } from '../ai/vision-parser.js';
import { createVisionIngest, type VisionIngest } from '../capture/vision-ingest.js';

/** 路由插件 opts：注入数据库、LM Studio 客户端、可选队列与可选视觉入库管线。 */
export interface VisionRoutesOptions extends FastifyPluginOptions {
  /** 数据库实例 */
  db: AppDatabase;
  /** LM Studio 客户端（供视觉识别器用） */
  client: LmStudioClient;
  /** 可选 AI 任务队列：提供时视觉识别经 enqueueDeferred 延后批处理 */
  queue?: AiQueue;
  /** 可选视觉入库管线：直接注入便于测试；缺省时现场构造 */
  visionIngest?: VisionIngest;
}

/** 单帧图片最大体积：25MB（与 app.ts 注册的 multipart 上限保持一致语义）。 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** 去掉可能的 data URL 前缀（data:image/...;base64,），返回纯 base64 字符串。 */
function stripDataUrlPrefix(b64: string): string {
  const match = /^data:[^;]+;base64,/.exec(b64);
  return match ? b64.slice(match[0].length) : b64;
}

/** 注册视觉入库路由。 */
export async function visionRoutes(
  app: FastifyInstance,
  opts: VisionRoutesOptions,
): Promise<void> {
  const { db, client, queue } = opts;
  // 允许直接注入 visionIngest（测试）；缺省现场构造识别器 + 入库管线
  const visionIngest =
    opts.visionIngest ??
    createVisionIngest({
      db,
      visionParser: createVisionParser(queue ? { client, queue } : { client }),
    });

  // POST /api/vision/ingest-frame — 接收 multipart 文件或 base64 body
  app.post('/api/vision/ingest-frame', async (request, reply) => {
    let buf: Buffer | undefined;

    // 先试 multipart 文件上传（仅在确为 multipart 请求时读取，避免对 JSON 请求抛错）
    if (request.isMultipart()) {
      const uploaded = await request.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
      if (uploaded !== undefined) {
        buf = await uploaded.toBuffer();
      }
    } else {
      // 否则读 body 中的 base64（去掉可能的 data URL 前缀）
      const body = request.body as { imageBase64?: unknown } | undefined;
      const imageBase64 = body?.imageBase64;
      if (typeof imageBase64 === 'string' && imageBase64.trim() !== '') {
        buf = Buffer.from(stripDataUrlPrefix(imageBase64.trim()), 'base64');
      }
    }

    // 两者都无 → 400 NO_IMAGE
    if (buf === undefined) {
      return reply.code(400).send({
        error: { message: '缺少图片', code: 'NO_IMAGE' },
      });
    }

    const items = await visionIngest.ingestFrame(buf, Date.now());
    return reply.send({ items });
  });

  // GET /api/vision/status — 返回入库统计
  app.get('/api/vision/status', async (_request, reply) => {
    return reply.send(visionIngest.getStats());
  });
}
