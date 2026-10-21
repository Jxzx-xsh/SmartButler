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
  /** 文本对话默认模型（也作为各文本任务的回退） */
  textModel: string;
  /** 视觉（多模态）默认模型 */
  visionModel: string;
  /** 向量嵌入默认模型 */
  embedModel: string;
  /**
   * 语音转写（STT）旧配置：LM Studio whisper 模型 id。
   * 注意：STT 现由本地 whisper.cpp 承担（见 src/ai/whisper.ts），此字段为
   * LM Studio 旧路径遗留，当前不参与转写，保留以便回滚或他用。
   */
  sttModel: string;
  /** 请求超时毫秒数（首次加载模型较慢，默认给到 120s） */
  timeoutMs: number;
  // ============ 任务专用模型 ============
  // 各文本任务可独立指定模型，缺省时回退到 textModel。
  // 这样部署方可根据任务复杂度灵活分配轻量/重型模型。
  /** 意图分类模型（简单文本分类，小模型通常足够） */
  intentModel: string;
  /** 物品文本解析模型（口语→结构化 JSON，需要日期换算） */
  itemParseModel: string;
  /** 视觉画面物品识别模型（多模态，必须支持视觉输入） */
  visionParseModel: string;
  /** 菜谱推荐模型（食材理解 + 结构化推荐） */
  recipeModel: string;
  /**
   * whisper.cpp 命令（whisper-cli）路径或命令名。
   * 缺省 'whisper-cli'（走 PATH）；brew install whisper-cpp 后实际在
   * /opt/homebrew/bin/whisper-cli。可用环境变量 WHISPER_CLI_PATH 覆盖为绝对路径。
   */
  whisperCliPath: string;
  /**
   * whisper.cpp 使用的 ggml 模型文件绝对路径。
   * 注意：须为 ggml `.bin` 模型，**不是 GGUF**；可从
   * huggingface.co/ggerganov/whisper.cpp 获取。可用环境变量 WHISPER_MODEL_PATH 覆盖。
   */
  whisperModelPath: string;
  /** whisper 转写语言，缺省 'zh'（中文家庭场景）。可用 WHISPER_LANGUAGE 覆盖。 */
  whisperLanguage: string;
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

  // 基础模型（默认值对应当前本地部署的两个模型）
  const textModel = env.LMSTUDIO_TEXT_MODEL ?? 'qwen/qwen3-1.7b';
  const visionModel = env.LMSTUDIO_VISION_MODEL ?? 'qwen/qwen3-vl-4b';
  const embedModel = env.LMSTUDIO_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5';
  const sttModel = env.LMSTUDIO_STT_MODEL ?? 'whisper-large-v3-turbo';

  return {
    baseUrl: env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: env.LMSTUDIO_API_KEY ?? 'lm-studio',
    textModel,
    visionModel,
    embedModel,
    sttModel,
    timeoutMs,
    // 任务专用模型：各环境变量独立覆盖，缺省时回退到 textModel / visionModel
    intentModel: env.LMSTUDIO_INTENT_MODEL ?? textModel,
    itemParseModel: env.LMSTUDIO_ITEM_PARSE_MODEL ?? textModel,
    visionParseModel: env.LMSTUDIO_VISION_PARSE_MODEL ?? visionModel,
    recipeModel: env.LMSTUDIO_RECIPE_MODEL ?? textModel,
    whisperCliPath: env.WHISPER_CLI_PATH ?? 'whisper-cli',
    whisperModelPath:
      env.WHISPER_MODEL_PATH ?? '/Users/hb02995/other-work/SmartButler/backend/models/ggml-small.bin',
    whisperLanguage: env.WHISPER_LANGUAGE ?? 'zh',
  };
}
