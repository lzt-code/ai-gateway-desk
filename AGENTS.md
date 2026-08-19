# Agents 通用规则

本文件为所有 AI 编码代理（Copilot、其他 agent）提供本仓库的通用行为准则。

## 项目简介

AI Gateway 模型管理工具（本地 Web 界面）+ 转发封装 Worker。

- `src/`：管理工具（Node.js ESM，本地 Web 界面，Hono 服务器 + 前端页面）
- `ai-gateway-desk-worker/`：Cloudflare Worker（零依赖转发层）
- `data/`：运行时数据（私有，已被 .gitignore 排除，勿提交）
- `docs/`：架构说明
- `test/`：测试（`npm test` 聚合入口 `test/run-all.mjs`）

## 通用规则

1. **图片传递限制**：如果当前模型没有明确支持图片识别，则不要在开发和调试中传递图片。需要引用图片内容时，改用文字描述。
2. **不提交私有数据**：`data/` 目录下的运行时数据（如 `models.json`、`providers.json`）不得写入 git。
3. **改动前先读上下文**：修改代码前先阅读相关文件，理解现有结构与约定，避免破坏既有行为。
4. **保持简洁**：优先最小改动解决问题，避免过度设计或无关重构。
