# SmartButler - 视觉识别链路引入 OCR 前置（Xiaomi-OCR-0）

## Overview
- **Summary**：在 `vision-parser` 识别链路上加入一个 OCR 前置阶段，先用 Xiaomi-OCR-0 抽取画面文字，再交给文本模型结构化；抽取失败时回退到当前整帧多模态识别路径。
- **Purpose**：利用 OCR-0 在文档/标签/小票文字识别上的精准度与速度（实测快 3–6 倍），提升视觉入库对有画面文字（包装标签、购物小票、清单）的识别召回率，同时避免其对实物识别与日期常识推理偏弱的短板。
- **Target Users**：SmartButler 本地部署者（当前 Mac mini），后端 Fastify 服务、PWA 前端、Home Assistant 集成。

## Goals
- 画面中存在可读文字时，结构化入库更稳、更快。
- 抽取文字为空时，整帧多模态识别结果与现状完全一致（回归安全）。
- 接入新增环境变量可开关，未设置时不额外调用 OCR 模型。

## Non-Goals
- 不替换、不删除现有多模态视觉模型路径。
- 不改 `item-parser.ts`、`capture/vision-ingest.ts`、路由层/前端/HA 集成代码。
- 不引入额外进程（继续走已有 LM Studio OpenAI 兼容端点）。
- 不把 OCR 模型加载强塞到 LM Studio（未安装或未加载时优雅降级）。

## Background & Context
- 本轮会话已完成 Xiaomi-OCR-0 在 LM Studio 上的可行性验证（LLama.cpp 运行时，上下文 16384，速度 ~125ms/token）。
- 同一张图片：OCR-0 文字识别全对，且返回速度约为 `qwen3-vl-4b` 的 1/5；但 OCR-0 对结构化 JSON 与相对日期推理会出现编造（例如把 2026-11-20 写成 2026-11-30）。
- 现有 `vision-parser.ts` 用单一视觉模型同时做「实物识别 + 画面文字识别 + 日期换算」，提示词已经过反复调优（过长提示词会让模型直接返回空 items）。

## Functional Requirements
- **FR-1**：`vision-parser.parseFrame` 收到一帧 JPEG 时，先尝试 OCR 抽取阶段。
- **FR-2**：OCR 抽取阶段使用独立模型名（环境变量 `LMSTUDIO_OCR_MODEL`）与独立、紧凑的纯文字抽取提示词，只保留画面中的可读文本，不描述布局。
- **FR-3**：OCR 文本非空时，使用文本模型（`LMSTUDIO_ITEM_PARSE_MODEL`）按 item-parser 的既有日期换算提示词结构化；OCR 文本为空或返回解析结果为空/空数组时，立即回退到原来的 `chatVisionJson` 整帧识别路径。
- **FR-4**：OCR 模型未配置（环境变量为空）时，OCR 抽取阶段完全跳过，行为与今天一致（零额外调用）。
- **FR-5**：OCR 调用抛出任何错误（超时、坏响应、模型未加载）均被吞噬并触发整帧路径回退；单个 eventLog 记录错误事件（source='vision', eventType='vision_ocr_error'），不中断入库管线。
- **FR-6**：回退触发时在标准输出打一条 `[vision] ocr 未产出物品，回退整帧识别` 级别 INFO 日志。
- **FR-7**：OCR 抽取阶段与 item-parser 结构化阶段共享 `aiQueue` 的 `enqueueDeferred`，保持视觉入库继续串行化、空闲批处理，不阻塞门控。
- **FR-8**：单帧总等待时间增加不超过 OCR 路径的耗时：若 OCR 快于整帧，则整体更快；最坏情况为两者之和（OCR 超时回退 + 整帧识别）。超时上限沿用 `LMSTUDIO_TIMEOUT_MS`。

## Non-Functional Requirements
- **NFR-1**：新增单元测试覆盖：OCR 成功 + 结构化；OCR 空回退整帧；OCR 错误回退整帧；OCR 未配置跳过；OCR + 整帧结果合并去重（name 归一化）。
- **NFR-2**：`vision-parser` 对外接口 `VisionParser.parseFrame` 签名与返回结构保持不变。
- **NFR-3**：新增日志 / 事件落库路径与现有 `vision_error` 一致，含必要上下文但不含图片字节。
- **NFR-4**：`.env.example` 同步补齐 `LMSTUDIO_OCR_MODEL` 文档。

## Constraints
- **Technical**：OCR 模型必须支持 chat completions 端点的 vision input（image_url），LM Studio 当前 `xiaomi-ocr-0` 已满足。
- **Dependencies**：依赖现有 `LmStudioClient`（OpenAI 兼容）与 `AiQueue`（enqueueDeferred）。
- **Business**：不新增数据库表、不改已定义的 `CreateItemInput` / `ParsedItem` 结构。

## Assumptions
- `LMSTUDIO_OCR_MODEL` 为空/未设置 → 完全跳 OCR（FR-4）。
- OCR 模型已被 LM Studio 加载且能响应 `/chat/completions`；未加载导致首次调用慢属正常（冷启动）。
- OCR 返回的文字中已包含足够日期线索让文本模型结构化，无需再走整帧视觉模型做日期换算。

## Acceptance Criteria

### AC-1：OCR 成功链路
- **Type**: `rule`
- **Given**：`LMSTUDIO_OCR_MODEL` 非空，OCR 与 item-parser 模型均能响应
- **When**：调用 `visionParser.parseFrame` 传入一张含可读中文标签/小票的 JPEG
- **Then**：返回的 `ParsedItem[]` 非空；`expiryDate` 字段不出现 OCR-0 编造日期（例如 11-30 应为 11-20）；全程未触发整帧 `chatVisionJson`
- **Pass Condition**：mock 单测里 OCR 路径被调用一次、整帧路径调用次数为 0；集成实测同一张标签图正确入库。
- **Evidence**：单测 `vision-parser.test.ts` 新增 case + 后端日志 `[vision] ocr → N 项`

### AC-2：OCR 空 → 回退整帧
- **Type**: `rule`
- **Given**：`LMSTUDIO_OCR_MODEL` 非空，OCR 抽取返回空串
- **When**：传入一张文字极少或完全无文字的帧
- **Then**：回退到整帧 `chatVisionJson` 路径，最终返回 `ParsedItem[]` 与当前版本在相同输入下一致
- **Pass Condition**：单测 mock OCR 返回空串后整帧路径被调用一次；`[vision] ocr 未产出物品，回退整帧识别` 日志出现。
- **Evidence**：新增单测 case + 日志

### AC-3：OCR 错误 → 回退整帧
- **Type**: `rule`
- **Given**：OCR 调用抛 `LmStudioError` / 超时 / 连接失败
- **When**：parseFrame 被调用
- **Then**：错误被吞噬、整帧路径继续执行；`eventLogs` 落一条 `vision_ocr_error`；整个 `parseFrame` 不抛错（由整帧结果决定）
- **Pass Condition**：单测让 OCR mock 抛错，整帧 mock 正常返回；eventLogs 有错误记录。
- **Evidence**：单测 + 数据库抽查

### AC-4：未配置 OCR 时零额外调用
- **Type**: `rule`
- **Given**：`LMSTUDIO_OCR_MODEL` 未设置或为空串
- **When**：parseFrame 被调用
- **Then**：代码路径与今天完全一致，零 OCR 模型调用
- **Pass Condition**：单测 `CreateVisionParserDeps.ocrModel` 缺省/为空时 chatVisionJson 只调用一次；端到端 `curl /api/capture/snapshot` 触发入库无额外耗时。
- **Evidence**：单测 + 实测耗时对比

### AC-5：接口稳定
- **Type**: `rule`
- **Given**：所有现有 `vision-parser.test.ts` 单测（不涉及 OCR 的）
- **When**：代码合入后跑一遍 vitest
- **Then**：原有用例全部通过
- **Pass Condition**：`npm --prefix backend test` 退出 0
- **Evidence**：vitest 输出

### AC-6：结构质量
- **Type**: `rubric`
- **Dimension**: 代码可读性与关注点分离
- **Scale**: 1-5
- **Anchors**: 1 = OCR 逻辑散落在 parseFrame 主体、难以阅读；3 = 有独立 helper 但耦合紧；5 = OCR 路径被 `runOcr` 独立封装、主 parseFrame 读起来像一句 if/else，依赖通过 deps 注入、测试能分别 mock
- **Pass Threshold**: >= 4
- **Evidence**: PR diff 结构评审

### AC-7：配置安全与默认值
- **Type**: `rule`
- **Given**：`backend/.env.example`
- **When**：查看 LM Studio 变量区
- **Then**：新增 `LMSTUDIO_OCR_MODEL=` 注释行，标注「留空关闭」，默认值回退到空（=关闭）
- **Pass Condition**：文件存在且格式与相邻变量一致
- **Evidence**: `.env.example` diff
