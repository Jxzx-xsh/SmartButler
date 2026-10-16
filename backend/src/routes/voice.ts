/**
 * 语音入库路由（Fastify 插件）。
 *
 * 打通「语音/文本 → 结构化解析 → 入库」渠道，提供两个端点：
 * - POST /api/voice/ingest-text：直接接收文本（已转写或手动输入）→ 解析 → 入库。
 *   让解析+入库能脱离 whisper STT 独立真实联调与演示。
 * - POST /api/voice/ingest：接收上传音频（multipart）→ 规范化（ffmpeg）→ 转写（whisper）
 *   → 解析 → 入库，走完整语音链路。
 *
 * 依赖通过 opts 注入：db（数据库）、client（LM Studio 客户端）、queue（可选 AI 队列）。
 * 内部用 createItemParser 构造解析器；解析出的 category 为分类名字符串，需经
 * listCategories 映射到已有分类 id（匹配不到则置空，不自动建分类）。
 *
 * 错误体统一为 { error: { message, code } }，与现有路由风格一致。
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';

import type { AppDatabase } from '../db/client.js';
import type { LmStudioClient } from '../ai/lmstudio.js';
import type { WhisperTranscriber } from '../ai/whisper.js';
import type { AiQueue } from '../ai/queue.js';
import { LmStudioError } from '../ai/errors.js';
import { createItemParser } from '../ai/item-parser.js';
import { normalizeAudio } from '../ai/audio.js';
import { persistParsedItems } from '../db/persist-items.js';
import { ingestTextBodySchema } from '../http/schemas.js';

/** 路由插件 opts：注入数据库、LM Studio 客户端、whisper 转写器与可选 AI 队列。 */
export interface VoiceRoutesOptions extends FastifyPluginOptions {
  /** 数据库实例 */
  db: AppDatabase;
  /** LM Studio 客户端（供 item-parser 解析用；STT 已不走它） */
  client: LmStudioClient;
  /** 本地 whisper.cpp 转写器：/api/voice/ingest 的语音转写由它承担 */
  transcriber: WhisperTranscriber;
  /** 可选 AI 任务队列：提供时解析任务经 enqueueImmediate 串行提交 */
  queue?: AiQueue;
}

/** 单个 ffmpeg 可接受音频的最大体积：25MB（与 app.ts 注册的上限保持一致语义）。 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** 注册语音入库路由。 */
export async function voiceRoutes(
  app: FastifyInstance,
  opts: VoiceRoutesOptions,
): Promise<void> {
  const { db, client, transcriber, queue } = opts;
  // 构造物品解析器：queue 存在时解析任务走队列即时串行提交
  const parser = createItemParser(queue ? { client, queue } : { client });

  // POST /api/voice/ingest-text — 文本直接解析入库（可脱离 whisper 独立联调）
  app.post('/api/voice/ingest-text', async (request, reply) => {
    // body 校验失败抛 ZodError，由 app 统一错误处理转 400
    const { text } = ingestTextBodySchema.parse(request.body);
    const parsed = await parser.parse(text);
    const items = persistParsedItems(db, parsed, 'voice');
    return reply.send({ transcript: text, items });
  });

  // POST /api/voice/ingest — 上传音频 → 规范化 → 转写 → 解析 → 入库
  app.post('/api/voice/ingest', async (request, reply) => {
    // 取上传的音频文件（@fastify/multipart）
    const uploaded = await request.file({ limits: { fileSize: MAX_AUDIO_BYTES } });
    if (uploaded === undefined) {
      return reply.code(400).send({
        error: { message: '缺少上传的音频文件', code: 'NO_AUDIO' },
      });
    }

    const audio = await uploaded.toBuffer();

    // 规范化音频（ffmpeg）：ffmpeg 不可用时抛错 → 503 FFMPEG_UNAVAILABLE
    let wavBuffer: Buffer;
    try {
      wavBuffer = await normalizeAudio(audio);
    } catch (err) {
      return reply.code(503).send({
        error: {
          message: err instanceof Error ? err.message : '音频规范化失败',
          code: 'FFMPEG_UNAVAILABLE',
        },
      });
    }

    // 语音转写（本地 whisper.cpp）：连接/超时类错误 → 503 STT_UNAVAILABLE；
    // 非零退出/空转写等结构异常 → 502。transcriber 复用 LmStudioError，故下方
    // 错误分支与原 LM Studio 方案完全一致。
    // 注意：路由侧已先 normalizeAudio 转过 wav，whisper.transcribe 内部对 wav
    // 还会再 normalize 一次（幂等、开销小），保持路由侧 normalize 不动以维持
    // 既有 FFMPEG_UNAVAILABLE 分支与测试。
    let transcript: string;
    try {
      transcript = await transcriber.transcribe({ audio: wavBuffer });
    } catch (err) {
      if (err instanceof LmStudioError) {
        if (err.kind === 'connection' || err.kind === 'timeout') {
          return reply.code(503).send({
            error: { message: '语音转写服务不可用', code: 'STT_UNAVAILABLE' },
          });
        }
        if (err.kind === 'bad_response') {
          return reply.code(502).send({
            error: { message: '语音转写返回异常', code: 'STT_BAD_RESPONSE' },
          });
        }
      }
      // 其余交给 app 统一错误处理（500）
      throw err;
    }

    const parsed = await parser.parse(transcript);
    const items = persistParsedItems(db, parsed, 'voice');
    return reply.send({ transcript, items });
  });
}
