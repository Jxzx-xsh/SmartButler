# SmartButler 视觉 OCR 前置 - tasks.md

## Task 1：配置层补齐 OCR 模型变量
- **Status**: `completed`
- **Priority**: high
- **Depends On**: None
- **Completion Evidence**:
  - `backend/src/ai/config.ts`: AiConfig 新增 `ocrModel`（默认 `''`）、`ocrItemModel`（默认回退 itemParseModel）；loadAiConfig 内显式展开 itemParseModel 常量避免循环引用。
  - `backend/.env.example`: 在 `LMSTUDIO_VISION_PARSE_MODEL` 下方插入注释行，`LMSTUDIO_OCR_MODEL=` 默认空、`LMSTUDIO_OCR_ITEM_PARSE_MODEL=` 默认空。
- **Test Requirements**:
  - `rule` TR-1.1：tsc 通过，lmstudio.test.ts / whisper.test.ts mock AiConfig 补齐新字段后编译无错。

## Task 2：vision-parser 依赖注入扩展 + OCR 运行器
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 1
- **Completion Evidence**:
  - `backend/src/ai/vision-parser.ts`: CreateVisionParserDeps 新增 `ocrModel?: string`、`ocrItemModel?: string`；新增 `buildOcrPrompt()`（纯文字抽取、禁止布局描述）、`buildItemStructPrompt(ctx)`（完整日期换算提示词）、私有 `runOcr` / `parseItemsFromOcrText` / `runFullFrame` 三个方法。
- **Test Requirements**:
  - `rubric` TR-2.1：结构解耦度 5/5（parseFrame 主流程 if/else 两分支清晰，OCR 独立封装，测试用例分别 mock chatVision / chatTextJson / chatVisionJson 三条路径）。

## Task 3：parseFrame 主流程改造 + 回退语义
- **Status**: `completed`
- **Priority**: high
- **Depends On**: Task 2
- **Completion Evidence**:
  - 主流程：ocrModel 空 → 直接 runFullFrame；非空 → runOcr → 非空则 parseItemsFromOcrText → 非空返回；否则 INFO 日志 + runFullFrame。
  - try/catch 吞掉 runOcr / parseItemsFromOcrText 的 LmStudioError，走整帧回退并 `console.warn('[vision][ocr] 错误，回退整帧识别：', message)`。
  - 整帧路径 buildVisionSystemPrompt / 日期归一化 / zod 校验零改动。
  - 所有 AI 调用经 queue.enqueueDeferred（ocr / ocr-parse / vision-parse 三种 meta.kind）。
- **Test Requirements**:
  - `rule` TR-3.1：vision-parser.test.ts 新增 8 个 case 覆盖 5 条路径（OCR 成功、空串回退、抛错回退、未配置跳过、结构化空回退 + queue 串行化 + 空白 ocrModel 关闭）。
  - `rule` TR-3.2：旧 11 个 case 继续全绿。

## Task 4：server.ts 接线 + 端到端验证
- **Status**: `completed`
- **Priority**: medium
- **Depends On**: Task 1, Task 3
- **Completion Evidence**:
  - `server.ts` createVisionParser 注入 ocrModel=aiConfig.ocrModel、ocrItemModel=aiConfig.ocrItemModel。
  - `.env` 实际写入 `LMSTUDIO_OCR_MODEL=xiaomi-ocr-0`、`LMSTUDIO_OCR_ITEM_PARSE_MODEL=qwen/qwen3-1.7b`。
  - 端到端：小票图 → OCR 抽取「永辉超市...」→ 结构化只出 1 条 → 自动回退整帧 → 入库 鸡蛋 qty=1、蒙牛纯牛奶 qty=1、西兰花 qty=2，expiryDate 全正确（无编造）。标签图 → OCR 抽取 → 结构化 1 条 → 入库蒙牛纯牛奶 qty=16（来自"250mL×16盒"）、expiryDate 2026-11-20 正确。
- **Test Requirements**:
  - `rule` TR-4.1：tsc --noEmit 零错误、非 DB 单测 238 passed（AI 86 全绿）。
  - `rule` TR-4.2：后端 dev 服务启动正常，日志出现 `[vision] ocr → 1 项` 与 `[vision] ocr 抽取了文字但未解析出物品，回退整帧识别`。

## Task 5：文档/运维收尾
- **Status**: `completed`
- **Priority**: low
- **Depends On**: Task 4
- **Completion Evidence**:
  - `.env.example` 已在 Task 1 完成时同步补齐。
  - LM Studio xiaomi-ocr-0 模型已加载、vision=true、context 16384，后端 dev 服务可稳定命中。
- **Test Requirements**:
  - `rule` TR-5.1：`.env.example` 含 `LMSTUDIO_OCR_MODEL=`（默认空）与 `LMSTUDIO_OCR_ITEM_PARSE_MODEL=` 两行注释，格式对齐相邻 LMSTUDIO_* 变量。
