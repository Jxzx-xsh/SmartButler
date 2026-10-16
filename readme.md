# SmartButler 家庭智能管家

## 简介

用于记录家庭食材、物品及各种到期时间的本地化智能管家系统。核心是食材 / 物品管理 + 到期提醒，支持界面手动输入、语音转文字、视频 / 拍照识别多渠道录入，并与 Home Assistant 双向集成。全部本地运行，注重隐私。

## 架构一句话

Android 手机现成推流 App → Mac mini 采集网关 + 门控（移动侦测 / VAD）→ 本地大模型（LM Studio）分析入库 SQLite → Fastify 后端 API / WS 对接 React PWA 与 Home Assistant。

## 快速开始

安装依赖、配置 `.env`、初始化数据库、一键起前后端的完整步骤见：

- [docs/部署指南.md](docs/部署指南.md)

最短路径：

```bash
npm install && npm --prefix backend install && npm --prefix pwa install
cp backend/.env.example backend/.env
npm run db:init
npm run dev
```

## 功能清单

- **手动录入**：PWA 表单增删改查物品，临期看板高亮。
- **语音录入**：上传音频经 whisper 转写，或直接文本，结构化解析入库。
- **视觉录入**：摄像头 / 图片经本地视觉模型识别物品并估计到期，低置信标记待确认。
- **到期提醒**：核心能力，查询 N 天内到期（含已过期）清单。
- **实时监控**：手机推流 → 采集网关 → PWA 查看画面；门控仅在有变化时触发分析。
- **HA 集成**：读实体状态、控制设备、订阅事件，并把临期统计暴露为 HA 传感器。
- **指令路由**：一句中文指令分流到立即执行 / 物品记录 / 查询 / 未知四类。

## 技术栈

全 Node / TypeScript：后端 Fastify 5 + better-sqlite3 + Drizzle ORM，前端 React 18 PWA（Vite 6 + vite-plugin-pwa），本地大模型走 LM Studio（OpenAI 兼容 API），语音转写走本地 whisper.cpp，采集用 Android 手机现成推流 App + ffmpeg 拉流，门控集中在 Mac mini 侧。

## 项目结构

```
.
├── backend/   后端：Fastify API、SQLite、AI 接入、采集网关、门控、HA 集成
├── pwa/       前端：React PWA（物品管理 + 到期看板 + 监控）
├── docs/      文档：技术方案、部署指南、采集端配置
├── scripts/   脚本：start-dev.sh（一键起前后端）、smoke.sh（端到端冒烟）
└── package.json  根级编排：dev / build / db:init / db:seed / smoke
```

## 文档

- [docs/技术方案.md](docs/技术方案.md)：技术方案、架构设计、硬件清单与任务拆分。
- [docs/部署指南.md](docs/部署指南.md)：前置依赖、配置、启动步骤与 API 速查表。
- [docs/采集端配置.md](docs/采集端配置.md)：手机采集节点推流 App 配置。

## 实施阶段

- **阶段一（核心闭环）**：食材 / 物品管理可用（手动录入）。
- **阶段二（AI + 语音）**：接入 LM Studio，打通语音录入。
- **阶段三（采集 + 监控）**：手机采集、门控、视频识别与监控。
- **阶段四（集成）**：HA 双向集成、指令路由与全系统整合。
