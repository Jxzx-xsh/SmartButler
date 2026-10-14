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
  /**
   * 语音转写（STT）旧配置：LM Studio whisper 模型 id。
   * 注意：STT 现由本地 whisper.cpp 承担（见 src/ai/whisper.ts），此字段为
   * LM Studio 旧路径遗留，当前不参与转写，保留以便回滚或他用。
   */
  sttModel: string;
  /** 请求超时毫秒数（首次加载模型较慢，默认给到 120s） */
  timeoutMs: number;
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

  return {
    // 端点基址：默认指向本机 LM Studio（后端与 LM Studio 同在一台 Mac mini，
    // 用 localhost 不受局域网 IP 变化影响；若 LM Studio 在其他主机，用
    // 环境变量 LMSTUDIO_BASE_URL 覆盖为 http://<host>:1234/v1）
    baseUrl: env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    // API Key：LM Studio 本地不校验，占位字符串即可
    apiKey: env.LMSTUDIO_API_KEY ?? 'lm-studio',
    // 文本模型：默认 qwen3-4b
    textModel: env.LMSTUDIO_TEXT_MODEL ?? 'qwen/qwen3-4b-2507',
    // 视觉模型：默认 qwen3-vl-8b
    visionModel: env.LMSTUDIO_VISION_MODEL ?? 'qwen/qwen3-vl-8b',
    // 嵌入模型：默认 nomic-embed（768 维）
    embedModel: env.LMSTUDIO_EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5',
    // 语音转写模型（STT / whisper）：默认 whisper-large-v3-turbo。
    // 注意：这里的 id 以 LM Studio 实际加载的模型为准——加载完成后可用
    //   GET /v1/models（即 listModels()）确认真实可用的 id。
    // 不同打包来源 id 可能不同，常见为 'whisper-large-v3-turbo' 或
    //   'mlx-community/whisper-large-v3-turbo'（mlx 版）。
    // 若默认值与实际加载的 id 不一致，可用环境变量 LMSTUDIO_STT_MODEL 覆盖。
    sttModel: env.LMSTUDIO_STT_MODEL ?? 'whisper-large-v3-turbo',
    timeoutMs,
    // whisper.cpp 命令：缺省走 PATH 的 whisper-cli（brew 安装后在
    // /opt/homebrew/bin/whisper-cli）；可用 WHISPER_CLI_PATH 覆盖为绝对路径。
    whisperCliPath: env.WHISPER_CLI_PATH ?? 'whisper-cli',
    // whisper.cpp ggml 模型文件：须为 ggml .bin（非 GGUF），
    // 可从 huggingface.co/ggerganov/whisper.cpp 获取；可用 WHISPER_MODEL_PATH 覆盖。
    whisperModelPath:
      env.WHISPER_MODEL_PATH ?? '/Users/hb02995/other-work/SmartButler/backend/models/ggml-small.bin',
    // 转写语言：缺省中文；可用 WHISPER_LANGUAGE 覆盖。
    whisperLanguage: env.WHISPER_LANGUAGE ?? 'zh',
  };
}
