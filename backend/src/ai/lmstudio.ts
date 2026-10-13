/**
 * LM Studio 客户端封装（基于官方 openai 包）。
 *
 * 对外暴露 chatText / chatTextJson / chatVision / embed / listModels 五个方法，
 * 统一把 SDK 抛出的错误映射为带 kind 的 LmStudioError，便于调度器判断可否重试。
 * OpenAI 实例支持依赖注入，测试时注入 fake 即可脱离真实网络。
 */

import OpenAI, { APIConnectionTimeoutError, APIConnectionError, APIUserAbortError } from 'openai';

import { loadAiConfig, type AiConfig } from './config.js';
import { LmStudioError } from './errors.js';

/** 对话消息角色。 */
export type ChatRole = 'system' | 'user' | 'assistant';

/** 单条对话消息。 */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** chatText / chatTextJson 入参。 */
export interface ChatTextOptions {
  /** 模型名，缺省用 config.textModel */
  model?: string;
  /** 完整消息数组；与 system/user 二选一（优先 messages） */
  messages?: ChatMessage[];
  /** 便捷入参：system 提示词 */
  system?: string;
  /** 便捷入参：user 内容 */
  user?: string;
  /** 采样温度 */
  temperature?: number;
  /** 响应格式（透传为 response_format） */
  responseFormat?: { type: 'json_object' };
}

/** chatVision 入参。 */
export interface ChatVisionOptions {
  /** 模型名，缺省用 config.visionModel */
  model?: string;
  /** 文本提示词 */
  prompt: string;
  /** 图片列表：base64 data URL 或 http URL */
  images: string[];
  /** 采样温度 */
  temperature?: number;
}

/** embed 入参。 */
export interface EmbedOptions {
  /** 模型名，缺省用 config.embedModel */
  model?: string;
  /** 待嵌入文本，单条字符串或数组 */
  input: string | string[];
}

/** 对外客户端接口。 */
export interface LmStudioClient {
  /** 文本对话，返回首个 choice 的 content */
  chatText(opts: ChatTextOptions): Promise<string>;
  /** 文本对话并解析为 JSON（强制 json_object），解析失败抛 bad_response */
  chatTextJson<T = unknown>(opts: ChatTextOptions): Promise<T>;
  /** 多模态对话（文本 + 图片），返回文本 */
  chatVision(opts: ChatVisionOptions): Promise<string>;
  /** 文本嵌入，始终返回 number[][]（单条也包成一维数组的数组） */
  embed(opts: EmbedOptions): Promise<number[][]>;
  /** 列出可用模型 id */
  listModels(): Promise<string[]>;
}

/**
 * 注入用的 OpenAI 最小结构类型。
 *
 * 只声明本封装实际用到的方法，既能复用官方 OpenAI 实例（结构兼容），
 * 又能让测试注入一个仅实现这几个方法的 fake，而不必构造完整 SDK。
 */
export interface OpenAILike {
  chat: {
    completions: {
      create(body: ChatCompletionCreateBody): Promise<ChatCompletionResult>;
    };
  };
  embeddings: {
    create(body: EmbeddingCreateBody): Promise<EmbeddingResult>;
  };
  models: {
    list(): Promise<ModelsListResult>;
  };
}

/** chat.completions.create 请求体（本封装用到的字段）。 */
interface ChatCompletionCreateBody {
  model: string;
  messages: Array<{ role: ChatRole; content: string | VisionContentPart[] }>;
  temperature?: number;
  response_format?: { type: 'json_object' };
}

/** 视觉消息 content 数组元素。 */
type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * chat.completions.create 返回结构（本封装用到的字段）。
 * 注意：qwen3 的 message 可能额外携带 reasoning_content，这里允许其存在但不使用。
 */
interface ChatCompletionResult {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    } | null;
  }>;
}

/** embeddings.create 请求体。 */
interface EmbeddingCreateBody {
  model: string;
  input: string[];
}

/** embeddings.create 返回结构。 */
interface EmbeddingResult {
  data?: Array<{ embedding?: number[] | null } | null>;
}

/** models.list 返回结构。 */
interface ModelsListResult {
  data?: Array<{ id?: string | null } | null>;
}

/** createLmStudioClient 依赖注入入参。 */
export interface CreateLmStudioClientDeps {
  /** AI 配置，缺省调用 loadAiConfig() */
  config?: AiConfig;
  /** 注入的 OpenAI 实例（或兼容结构），缺省内部 new OpenAI(...) */
  openai?: OpenAILike;
}

/**
 * 把任意错误映射为 LmStudioError。
 * - 超时 / 用户中止 → timeout
 * - 连接失败（APIConnectionError / ECONNREFUSED / fetch failed）→ connection
 * - 其余 → unknown
 * 若本就是 LmStudioError（如 bad_response），原样抛出。
 */
function mapError(err: unknown): LmStudioError {
  if (err instanceof LmStudioError) {
    return err;
  }
  // 超时与用户中止归类为 timeout（可重试）
  if (err instanceof APIConnectionTimeoutError || err instanceof APIUserAbortError) {
    return new LmStudioError('LM Studio 请求超时', 'timeout', err);
  }
  // SDK 连接错误
  if (err instanceof APIConnectionError) {
    return new LmStudioError('无法连接 LM Studio', 'connection', err);
  }
  // 兜底：从错误信息/code 识别常见连接失败特征
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const msg = err.message ?? '';
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      return new LmStudioError('无法连接 LM Studio', 'connection', err);
    }
    if (code === 'ETIMEDOUT' || /timed? ?out|aborted/i.test(msg)) {
      return new LmStudioError('LM Studio 请求超时', 'timeout', err);
    }
    return new LmStudioError(msg || '未知 AI 调用错误', 'unknown', err);
  }
  return new LmStudioError('未知 AI 调用错误', 'unknown', err);
}

/** 把 ChatTextOptions 归一化为消息数组。 */
function toChatMessages(opts: ChatTextOptions): ChatMessage[] {
  if (opts.messages && opts.messages.length > 0) {
    return opts.messages;
  }
  const messages: ChatMessage[] = [];
  if (opts.system !== undefined) {
    messages.push({ role: 'system', content: opts.system });
  }
  if (opts.user !== undefined) {
    messages.push({ role: 'user', content: opts.user });
  }
  return messages;
}

/**
 * 创建 LM Studio 客户端。
 * @param deps 可选依赖：config 与 openai 实例（测试用注入）。
 */
export function createLmStudioClient(deps: CreateLmStudioClientDeps = {}): LmStudioClient {
  const config = deps.config ?? loadAiConfig();
  // 真实 OpenAI 实例的方法签名比本封装用到的更宽（含流式重载等），
  // 结构上并不精确等于 OpenAILike，这里经 unknown 收窄到最小接口。
  const openai: OpenAILike =
    deps.openai ??
    (new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      timeout: config.timeoutMs,
    }) as unknown as OpenAILike);

  /** 从 chat 返回里取出 content，缺失/非字符串按 bad_response 处理。 */
  function extractContent(result: ChatCompletionResult): string {
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new LmStudioError('LM Studio 返回缺少 content', 'bad_response', result);
    }
    return content;
  }

  async function chatText(opts: ChatTextOptions): Promise<string> {
    try {
      const body: ChatCompletionCreateBody = {
        model: opts.model ?? config.textModel,
        messages: toChatMessages(opts),
      };
      if (opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }
      if (opts.responseFormat !== undefined) {
        body.response_format = opts.responseFormat;
      }
      const result = await openai.chat.completions.create(body);
      return extractContent(result);
    } catch (err) {
      throw mapError(err);
    }
  }

  async function chatTextJson<T = unknown>(opts: ChatTextOptions): Promise<T> {
    // 强制 json_object 响应格式
    const text = await chatText({ ...opts, responseFormat: { type: 'json_object' } });
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new LmStudioError('LM Studio 返回的 JSON 解析失败', 'bad_response', err);
    }
  }

  async function chatVision(opts: ChatVisionOptions): Promise<string> {
    try {
      // 构造多模态 content 数组：首个 text 项 + 若干 image_url 项
      const content: VisionContentPart[] = [
        { type: 'text', text: opts.prompt },
        ...opts.images.map((url): VisionContentPart => ({ type: 'image_url', image_url: { url } })),
      ];
      const body: ChatCompletionCreateBody = {
        model: opts.model ?? config.visionModel,
        messages: [{ role: 'user', content }],
      };
      if (opts.temperature !== undefined) {
        body.temperature = opts.temperature;
      }
      const result = await openai.chat.completions.create(body);
      return extractContent(result);
    } catch (err) {
      throw mapError(err);
    }
  }

  async function embed(opts: EmbedOptions): Promise<number[][]> {
    try {
      // string 入参归一化为数组
      const input = typeof opts.input === 'string' ? [opts.input] : opts.input;
      const result = await openai.embeddings.create({
        model: opts.model ?? config.embedModel,
        input,
      });
      const data = result.data;
      if (!Array.isArray(data) || data.length === 0) {
        throw new LmStudioError('LM Studio 返回缺少嵌入数据', 'bad_response', result);
      }
      return data.map((item) => {
        const embedding = item?.embedding;
        if (!Array.isArray(embedding)) {
          throw new LmStudioError('LM Studio 返回的嵌入向量结构异常', 'bad_response', result);
        }
        return embedding;
      });
    } catch (err) {
      throw mapError(err);
    }
  }

  async function listModels(): Promise<string[]> {
    try {
      const result = await openai.models.list();
      const data = result.data;
      if (!Array.isArray(data)) {
        throw new LmStudioError('LM Studio 返回的模型列表结构异常', 'bad_response', result);
      }
      return data
        .map((item) => item?.id)
        .filter((id): id is string => typeof id === 'string');
    } catch (err) {
      throw mapError(err);
    }
  }

  return { chatText, chatTextJson, chatVision, embed, listModels };
}
