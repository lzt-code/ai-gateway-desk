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
5. **统一日志格式**：所有涉及 IO 的操作（Cloudflare REST、KV REST、wrangler/子进程、文件读写、本地网关直发厂商、Worker 转发）都必须走统一日志器，禁止用裸 `console.log` 记录业务 IO：
   - 主程序（`src/`）：`src/core/io-logger.js`；Worker（`ai-gateway-desk-worker/`）：`src/io-log.js`。
   - 默认必须输出 `logResult`（成功/失败 + `elapsedMs` + 关键摘要）；debug 开启时另输出 `logRequest`/`logResponse` 的脱敏细节（用模块内 mask 工具，禁止打印明文 token/secret/key）。
   - 操作名采用 `域:动作[:目标]` 风格，如 `gateway:chat:<slug>`、`routes:deploy`、`worker:chat:<slug>`。
   - 新增接口/功能时同步确认日志覆盖；主程序日志会进入环形缓冲供前端 SSE「处理过程日志」展示，勿绕过日志器另写输出。

## Skills 按需索引（低频，不常驻上下文）

> 低频、大正文的 skill 仅在此表登记，LLM 按需 `read` 对应 `SKILL.md`，并避免污染上下文。

| Skill | 功能 | 路径 | 触发词 |
|-------|------|------|--------|
| npm-publish | npm 四步发布：前置核验 → publish → tag+push → 验证 | `~/workspace/laoliu-skills/skills/npm-publish/SKILL.md` | 发布 npm / 打 tag / 发版 / publish / tag |


* 按需加载示例：`read ~/workspace/laoliu-skills/skills/npm-publish/SKILL.md`
