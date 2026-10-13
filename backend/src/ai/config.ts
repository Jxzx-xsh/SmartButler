/**
 * AI 接入层配置集中读取。
 *
 * 所有 LM Studio 相关参数都通过环境变量注入，缺省时回退到本地部署的默认值；
 * 这样部署方可按需用环境变量覆盖，而测试/开发无需额外配置即可运行。
 */

/** LM Studio（OpenAI 兼容端点）配置。 */
export interface AiConfig {
  /** OpenAI 兼容端点基址，形如 http://host:1234/v1 */
  baseUrl: string;
  /** API Key；LM Studio 不校验，占位即可 */
  apiKey: string;
  /** 文本对话默认模型 */
  textModel: string;
  /** 视觉（多模态）默认模型 */
  visionModel: string;
  /** 向量嵌入默认模型 */
  embedModel: string;
  /** 请求超时毫秒数（首次加载模型较慢，默认给到 120s） */
  timeoutMs: number;
}

/** 超时默认值：首次加载模型可能耗时数十秒，预留充足余量。 */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * 从环境变量读取 AI 配置并补齐默认值。
 * @param env 环境变量对象，默认 process.env（便于测试注入）。
 */
export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  // 超时按 Number 解析；非法（NaN）或缺省统一回退到默认值
  const parsedTimeout = Number(env.LMSTUDIO_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;

  return {
    // 端点基址：默认指向局域网内的 LM Studio
    baseUrl: env.LMSTUDIO_BASE_URL ?? 'http://192.168.208.114:1234/v1',
    // API Key：LM Studio 本地不校验，占位字符串即可
    apiKey: env.LMSTUDIO_API_KEY ?? 'lm-studio',
    // 文本模型：默认 qwen3-4b
    textModel: env.LMSTUDIO_TEXT_MODEL ?? 'qwen/qwen3-4b-2507',
    // 视觉模型：默认 qwen3-vl-8b
    visionModel: env.LMSTUDIO_VISION_MODEL ?? 'qwen/qwen3-vl-8b',
    // 嵌入模型：默认 nomic-embed（768 维）
    embedModel: env.LMSTUDIO_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5',
    timeoutMs,
  };
}
