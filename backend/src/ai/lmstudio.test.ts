/** LM Studio 客户端封装单元测试（注入 fake OpenAI，不触网） */

import { describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError } from 'openai';

import { createLmStudioClient, type OpenAILike } from './lmstudio.js';
import { LmStudioError } from './errors.js';
import type { AiConfig } from './config.js';

/** 测试用固定配置，避免依赖环境变量 */
const testConfig: AiConfig = {
  baseUrl: 'http://test:1234/v1',
  apiKey: 'test-key',
  textModel: 'text-model',
  visionModel: 'vision-model',
  embedModel: 'embed-model',
  sttModel: 'stt-model',
  timeoutMs: 1000,
  intentModel: 'intent-model',
  itemParseModel: 'item-parse-model',
  visionParseModel: 'vision-parse-model',
  recipeModel: 'recipe-model',
  whisperCliPath: 'whisper-cli',
  whisperModelPath: '/tmp/ggml-small.bin',
  whisperLanguage: 'zh',
};

/** 构造一个可控的 fake OpenAI 实例 */
function makeFakeOpenai(overrides?: {
  chatCreate?: ReturnType<typeof vi.fn>;
  embeddingsCreate?: ReturnType<typeof vi.fn>;
  modelsList?: ReturnType<typeof vi.fn>;
}): {
  openai: OpenAILike;
  chatCreate: ReturnType<typeof vi.fn>;
  embeddingsCreate: ReturnType<typeof vi.fn>;
  modelsList: ReturnType<typeof vi.fn>;
} {
  const chatCreate = overrides?.chatCreate ?? vi.fn();
  const embeddingsCreate = overrides?.embeddingsCreate ?? vi.fn();
  const modelsList = overrides?.modelsList ?? vi.fn();
  const openai: OpenAILike = {
    chat: { completions: { create: chatCreate } },
    embeddings: { create: embeddingsCreate },
    models: { list: modelsList },
  };
  return { openai, chatCreate, embeddingsCreate, modelsList };
}

describe('chatText', () => {
  it('messages 入参原样透传并解析 content', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '你好' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatText({
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '用户' },
      ],
      temperature: 0.3,
    });

    expect(out).toBe('你好');
    expect(chatCreate).toHaveBeenCalledWith({
      model: 'text-model',
      messages: [
        { role: 'system', content: '系统' },
        { role: 'user', content: '用户' },
      ],
      temperature: 0.3,
    });
  });

  it('system+user 入参会组装成 messages 数组', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await client.chatText({ system: '你是助手', user: '在吗', model: 'custom-model' });

    expect(chatCreate).toHaveBeenCalledWith({
      model: 'custom-model',
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '在吗' },
      ],
    });
  });

  it('responseFormat 透传为 response_format', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{}' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await client.chatText({ user: 'x', responseFormat: { type: 'json_object' } });

    expect(chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: { type: 'json_object' } }),
    );
  });

  it('message 带 reasoning_content 时仍只取 content', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { reasoning_content: '思考过程...', content: '最终答案' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatText({ user: 'x' });
    expect(out).toBe('最终答案');
  });

  it('content 缺失抛 bad_response', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { reasoning_content: '只有思考' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.chatText({ user: 'x' })).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
  });
});

describe('chatTextJson', () => {
  it('解析成功返回对象，并用 text 响应格式（兼容 LM Studio，不用 json_object）', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"name":"牛奶","qty":2}' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatTextJson<{ name: string; qty: number }>({ user: 'x' });
    expect(out).toEqual({ name: '牛奶', qty: 2 });
    // LM Studio 新版 response_format 只接受 'json_schema'/'text'，chatTextJson 用 text
    expect(chatCreate).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: { type: 'text' } }),
    );
  });

  it('容错解析：剥离 markdown 代码块包裹后仍能解析', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '```json\n{"name":"酸奶","qty":3}\n```' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatTextJson<{ name: string; qty: number }>({ user: 'x' });
    expect(out).toEqual({ name: '酸奶', qty: 3 });
  });

  it('容错解析：剥离前后缀文字后截取 JSON', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '好的，结果是：{"name":"鸡蛋","qty":10} 以上。' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatTextJson<{ name: string; qty: number }>({ user: 'x' });
    expect(out).toEqual({ name: '鸡蛋', qty: 10 });
  });

  it('非法 JSON 抛 bad_response', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '不是 json' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.chatTextJson({ user: 'x' })).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
  });

  it('容错解析：多个顶层对象拆段输出时按键合并（小模型常见失败模式）', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '{"thinking":"优先用掉牛奶"}\n{\n  "recipes": [{"name":"番茄炒蛋","usedItems":["番茄"]}]\n}',
          },
        },
      ],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatTextJson<{ thinking: string; recipes: Array<{ name: string }> }>({
      user: 'x',
    });
    expect(out.thinking).toBe('优先用掉牛奶');
    expect(out.recipes).toHaveLength(1);
    expect(out.recipes[0]?.name).toBe('番茄炒蛋');
  });

  it('容错解析：字符串值内含花括号不影响结构扫描', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: '{"thinking":"格式是 {thinking, recipes} 这样的","recipes":[]}',
          },
        },
      ],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatTextJson<{ thinking: string }>({ user: 'x' });
    expect(out.thinking).toBe('格式是 {thinking, recipes} 这样的');
  });
});

describe('chatVision', () => {
  it('构造含 text 项与多张 image_url 的 content 数组', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '看到两张图' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatVision({
      prompt: '描述图片',
      images: ['data:image/png;base64,AAA', 'http://example.com/a.jpg'],
    });

    expect(out).toBe('看到两张图');
    expect(chatCreate).toHaveBeenCalledWith({
      model: 'vision-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '描述图片' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            { type: 'image_url', image_url: { url: 'http://example.com/a.jpg' } },
          ],
        },
      ],
    });
  });
});

describe('chatVisionJson', () => {
  it('正常 JSON 文本解析成功', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"items":[{"name":"牛奶"}]}' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatVisionJson<{ items: Array<{ name: string }> }>({
      prompt: '识别物品',
      images: ['data:image/jpeg;base64,AAA'],
    });
    expect(out).toEqual({ items: [{ name: '牛奶' }] });
  });

  it('容错解析：带 ```json 围栏 + 前后缀文字时仍能解析', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [
        { message: { content: '识别结果如下：\n```json\n{"items":[{"name":"鸡蛋"}]}\n``` 完毕。' } },
      ],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.chatVisionJson<{ items: Array<{ name: string }> }>({
      prompt: '识别物品',
      images: ['data:image/jpeg;base64,AAA'],
    });
    expect(out).toEqual({ items: [{ name: '鸡蛋' }] });
  });

  it('非 JSON/坏文本抛 bad_response', async () => {
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '没有可识别的物品' } }],
    });
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(
      client.chatVisionJson({ prompt: '识别物品', images: ['data:image/jpeg;base64,AAA'] }),
    ).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
  });
});

describe('embed', () => {
  it('string 入参归一化为数组并返回 number[][]', async () => {
    const embeddingsCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    });
    const { openai } = makeFakeOpenai({ embeddingsCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.embed({ input: '牛奶' });
    expect(out).toEqual([[0.1, 0.2, 0.3]]);
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: 'embed-model',
      input: ['牛奶'],
      encoding_format: 'float',
    });
  });

  it('string[] 入参返回多条 number[][]', async () => {
    const embeddingsCreate = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 2] }, { embedding: [3, 4] }],
    });
    const { openai } = makeFakeOpenai({ embeddingsCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.embed({ input: ['牛奶', '鸡蛋'] });
    expect(out).toEqual([[1, 2], [3, 4]]);
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: 'embed-model',
      input: ['牛奶', '鸡蛋'],
      encoding_format: 'float',
    });
  });
});

describe('listModels', () => {
  it('返回模型 id 字符串数组', async () => {
    const modelsList = vi.fn().mockResolvedValue({
      data: [{ id: 'qwen/qwen3-4b-2507' }, { id: 'text-embedding-nomic-embed-text-v1.5' }],
    });
    const { openai } = makeFakeOpenai({ modelsList });
    const client = createLmStudioClient({ config: testConfig, openai });

    const out = await client.listModels();
    expect(out).toEqual(['qwen/qwen3-4b-2507', 'text-embedding-nomic-embed-text-v1.5']);
  });
});

describe('错误映射', () => {
  it('连接错误映射为 connection', async () => {
    const chatCreate = vi.fn().mockRejectedValue(
      new APIConnectionError({ message: 'fetch failed', cause: new Error('ECONNREFUSED') }),
    );
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.chatText({ user: 'x' })).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'connection',
    });
  });

  it('超时错误映射为 timeout', async () => {
    const chatCreate = vi.fn().mockRejectedValue(new APIConnectionTimeoutError({ message: 'timed out' }));
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.chatText({ user: 'x' })).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'timeout',
    });
  });

  it('普通 ECONNREFUSED 错误映射为 connection', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const embeddingsCreate = vi.fn().mockRejectedValue(err);
    const { openai } = makeFakeOpenai({ embeddingsCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.embed({ input: '牛奶' })).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'connection',
    });
  });

  it('响应结构异常映射为 bad_response', async () => {
    const modelsList = vi.fn().mockResolvedValue({ data: null });
    const { openai } = makeFakeOpenai({ modelsList });
    const client = createLmStudioClient({ config: testConfig, openai });

    await expect(client.listModels()).rejects.toMatchObject({
      name: 'LmStudioError',
      kind: 'bad_response',
    });
  });

  it('其余错误映射为 unknown', async () => {
    const chatCreate = vi.fn().mockRejectedValue(new Error('something odd'));
    const { openai } = makeFakeOpenai({ chatCreate });
    const client = createLmStudioClient({ config: testConfig, openai });

    const err = await client.chatText({ user: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LmStudioError);
    expect((err as LmStudioError).kind).toBe('unknown');
  });
});
