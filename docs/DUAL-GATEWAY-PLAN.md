# 本地网关方案（本机出口 IP 直发）

> 本文是「本地网关」的设计总纲。源码为唯一真相，本文描述架构、模块职责、
> 数据模型与关键数据流。
>
> 创建：2026-09-21；同日修订：移除早期「cloud 模式下本地网关作为隧道」
> 的设计（见 §1 决策）。配套阅读：[ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 背景与定位

默认调用链：

```
Agent → 云端 Worker（ai-gateway-desk-worker）→ Cloudflare AI Gateway → AI 厂商
```

Cloudflare AI Gateway 的出口 IP 在其全球边缘节点，是大量用户共享的 IP 段。部分 AI Provider 会对这类共享 IP 做风控，导致高频调用时容易收到 `429 Too Many Requests`，即使自身 Key 额度充足也会被误伤。

**本地网关**让请求从用户本机出口 IP 直发厂商，绕开共享 IP，降低 429 概率。

### 1.1 两条路线如何共存（决策）

| 路线 | Agent Base URL | 出口 IP | 适用 |
|------|----------------|---------|------|
| 本地网关 | `http://127.0.0.1:8788/v1` | 用户本机 IP | 规避共享 IP 的 429 |
| Cloudflare | 云端 Worker 地址（直连） | Cloudflare 边缘共享 IP | 需要 analytics / 缓存 / 预算限流，或本机网络无法直连厂商 |

**关键决策**：Cloudflare 路线由 Agent **直接指向 Worker URL**，本地网关不再充当转发跳。早期方案曾设计「cloud 模式下本地网关作为隧道」，但该跳不带来协议增益（不解决 429、不改善 workers.dev 可达性），Agent 本可直连 Worker，故移除。本地网关只做一件事：本机出口 IP 直发。

Worker 本身保持零依赖、无状态，无需为本地网关做任何改动。

## 2. 目标与非目标

### 2.1 目标

1. 提供 `aigd gateway` 长驻进程，对外提供 OpenAI 兼容端点（仅绑 `127.0.0.1`）。
2. 解析模型的 provider slug → 取本机加密凭证 → 本机出口 IP 直连厂商，流式透传。
3. 支持本地动态路由 fallback 链（复用 `data/routes.json`）。
4. 与 Cloudflare 路线共用同一套 Provider / 模型 / 路由配置，凭证可云端回填。

### 2.2 非目标

1. 不做本地网关到云端 Worker 的转发 / 隧道。
2. 不做按 Provider 粒度的路由分流（本地 / 云端二选一，由 Agent Base URL 决定）。
3. 不在 web UI 中启停 / 托管网关进程（v1 由独立终端启动）。
4. 不监听局域网、不做远程多 PC 共用。
5. 不复制 Cloudflare 的 analytics / 缓存 / 预算限流。
6. 不集成 Portkey（理由见 §10）。

## 3. 整体架构

```
                          ┌──────────────────────────────────────────┐
   本地路线 Agent         │  aigd gateway（长驻，127.0.0.1:8788）      │
 base_url 127.0.0.1:8788 ►│  OpenAI 兼容端点 + 网关管理 API            │
                          └───────────────┬──────────────────────────┘
                                          ▼
                          ┌──────────────────────┐
                          │ LocalBackend          │
                          │ 本地 key（加密存储）   │
                          │ 本机出口 IP 直发厂商   │
                          │ + 本地 fallback 引擎  │
                          └──────────┬───────────┘
                                     ▼
                               AI 厂商直连

   Cloudflare 路线 Agent ──直连──► 云端 Worker → CF AI Gateway → 厂商
```

- `POST /v1/chat/completions`：进入 `LocalBackend`。
- `GET /v1/models`：直接读本地 `data/models.json`。

## 4. 请求流

```
Agent → 本地 gateway
  → 解析 body.model 中的 provider slug（要求 model 形如 '<slug>/<模型名>'）
  → 从本地加密存储取该 provider 的凭证 headers
  → 取 providers.json 中该 provider 的 base_url（+ pathPrefix）
  → 构造厂商真实端点，本机出口 IP 直连
  → 流式透传响应
若 model 为 dynamic/<name> → 进入本地 fallback 引擎（见 §8）
```

## 5. 目录结构

```
ai-gateway-desk/
├── src/
│   ├── bin/aigd.js                 # gateway 子命令
│   ├── gateway/
│   │   ├── server.js               # Hono app 工厂 + 启动器
│   │   ├── config-store.js         # data/gateway.json 读写（仅 port）
│   │   ├── router.js               # slug 解析/剥离、厂商 URL 构造
│   │   ├── provider-keys.js        # 厂商凭证本地加密存储
│   │   ├── provider-lookup.js      # slug → providers.json 条目
│   │   ├── backends/local.js       # LocalBackend
│   │   └── fallback.js             # 本地动态路由引擎
│   └── web/
│       ├── server.js               # 网关视图 API（overview/backfill/key）
│       └── public/app.js           # 「网关」视图
├── data/
│   ├── gateway.json                # gitignore：{ port }
│   └── gateway.example.json        # 提交：模板
└── test/
    ├── run-all.mjs
    └── test-gateway-*.mjs
```

## 6. 网关服务器 — `src/gateway/server.js`

- Hono 应用工厂 `createGatewayApp(deps)`，依赖注入，对齐 `web/server.js` 的可测模式。
- 独立启动器 `startGateway({ port })`，`@hono/node-server`，仅绑 `127.0.0.1`，无心跳退出。
- CORS 与 Worker 一致，动态回显预检所需头。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 进入 `LocalBackend` |
| `/v1/models` | GET | 读本地 `data/models.json`，包装为 `{ object:'list', data }` |
| `/health` | GET | 网关进程存活 + backend 健康 |
| `/api/gateway/status` | GET | 端口、各 provider 本地凭证状态 |
| `/api/gateway/backfill-keys` | POST | 从云端拉 custom-provider 完整 key 回填本地 |

EADDRINUSE 返回友好提示。

## 7. 凭证策略

### 7.1 凭证存储 — `src/gateway/provider-keys.js`

- 复用 `src/core/token-store.js` 系统级加密原语：Windows DPAPI / macOS Keychain / Linux 0600 文件。
- 在 `~/.ai-gateway-desk/provider-keys/<slug>` 存完整 headers 对象（兼容自定义鉴权头）。
- 测试通过 `AI_GW_TEST_DIR` 隔离。

### 7.2 是否需要重填 Key

| 类型 | 云端可读回完整 key | 处理 |
|------|--------------------|------|
| custom-provider | **可以**：`listCustomProviders` 的 `headers` 为完整未脱敏字符串 | 自动回填，用户无感 |
| byok | **不可以**：仅返回 `secret_preview` 掩码 | UI 重新录入一次 |

自动回填前置：本地存有管理 API Token。无 Token 时 UI 降级提示手工录入。

### 7.3 录入即双写

新增 / 覆盖 / 删除 Provider 时，在写云端之外同步写 / 删本地加密存储。本地写失败需明确告警但不阻断云端结果。

## 8. 本地动态路由 fallback 引擎 — `src/gateway/fallback.js`

执行语义（对齐 Cloudflare）：

1. 从 `start` 进入首个 `model` 节点。
2. 每个 `model` 节点按 `timeout` / `retries` 调用对应 provider 的本地直发。
3. 可重试错误（网络失败 / 429 / 5xx）重试耗尽后走 `fallback` 边。
4. 收到 200 即成功并开始流式返回；4xx（非 429）立即报错。
5. 支持 `percentage` 随机权重。
6. `conditional` / `rate` / 组合节点返回明确错误：该结构仅 Cloudflare 支持，请让 Agent 直连 Worker。

限制：**流式开始后无法回退**（上游 200 后 SSE 中途出错不能切换，Cloudflare 同理）。

## 9. 数据模型

### 9.1 `data/gateway.json`（gitignore）

```json
{ "port": 8788 }
```

`port`：正整数 1–65535，默认 8788。旧文件中的 `mode` / `cloudWorkerUrl` 字段在读取时被忽略。

### 9.2 Worker 地址

由「网关」视图通过 Cloudflare API 自动发现（`discoverWorkerEndpoints`，聚合在 `GET /api/gateway/overview`），覆盖三类绑定：
- workers.dev 默认地址：账户子域（`GET /workers/subdomain`）+ 脚本开关（`GET /workers/scripts/{name}/subdomain`）；
- Custom Domains：`GET /workers/domains`；
- Workers Routes（zone 路由）：`GET /zones` + `GET /zones/{id}/workers/routes`，路由模式（如 `*.example.com/api/*`）转换为 Agent Base URL；host 含通配符时以 `<子域>` 占位提示替换。

地址仅用于展示与引导 Agent 直连，本地网关不会请求，也不本地存储（旧 `gateway.workerUrl` 字段不再读取）。

> **后续优化（待实现）：Workers Routes 的 `<子域>` 自动解析**
>
> 现状：路由模式 host 含通配符（如 `*.example.com/api/*`）时仅以 `<子域>` 占位，
> 需用户自行到 Cloudflare DNS 中确认可用子域。
>
> 计划改为通过 API 自动解析：
> - 管理 Token 需新增权限（引导流程 `aigd setup` 的权限列表同步更新）：
>   - Zone → Zone → Read（列 zone，现有 Token 已具备）
>   - Zone → DNS  → Read（列 DNS 记录）
> - 调用 `GET /zones/{id}/dns_records`，取 `proxied=true` 记录与路由模式匹配：
>   - 有具体代理子域记录 → 直接给出可用 Base URL；
>   - 有 `*` 通配代理记录 → 任意子域可用；
>   - 无匹配记录 → 提示需先在 DNS 添加代理记录；
>   - DNS 接口 403（旧 Token 无权限）→ 降级提示补充 DNS Read 权限。
> - Token 权限只能在 Cloudflare 面板手动编辑（API 无法自改），Token 字符串不变。

### 9.3 现有数据文件（结构不变）

| 文件 | 角色 |
|------|------|
| `data/providers.json` | gateway / kv / providers 配置 |
| `data/model-states.json` | 模型状态唯一真相源 |
| `data/models.json` | 生成产物，本地 `/v1/models` 来源 |
| `data/routes.json` | 动态路由本地真相源：CF 云端执行 / 本地引擎执行 |

## 10. 为什么不集成 Portkey

1. `@portkey-ai/gateway` 仅暴露 `bin`，未导出可 import 的 app 入口；源码集成需 TS 工具链或维护 fork。
2. 带来 14 个依赖（ioredis、avsc、smithy、ws 等）与 `patch-package`，与克制的依赖风格冲突。
3. 现有 provider 均为 OpenAI 兼容，Portkey 的多协议转换 / guardrails 大部分用不上。

核心诉求是换出口 IP，自建薄层即可满足。

## 11. CLI 与 Web UI

### 11.1 CLI

```bash
aigd gateway [--port 8788]
```

- 默认读 `data/gateway.json`，`--port` 与 `AIGD_GATEWAY_PORT` 可覆盖。
- 长驻进程，打印监听地址，Ctrl+C 退出。

### 11.2 Web UI「网关」视图

- 操作面板：从云端回填 Key、刷新。
- 两张卡片：本地网关（运行状态、监听地址、Base URL 复制）、云端 Worker（地址、部署 / 编辑，直连说明）。
- 各 provider 本地凭证状态表；BYOK 标记「需重新录入」。
- v1 不在 UI 中启停网关进程。

## 12. 测试

延续纯函数 + 依赖注入，不触真实网络与凭证：

| 测试文件 | 覆盖 |
|----------|------|
| `test-gateway-config-store.mjs` | gateway.json 端口读写、校验、默认值、忽略旧字段 |
| `test-gateway-provider-keys.mjs` | 按 slug 读写 / 覆盖 / 删除 headers |
| `test-gateway-router.mjs` | slug 解析 / 剥离、URL 构造 |
| `test-gateway-backend-local.mjs` | LocalBackend 直发、流式、错误归类 |
| `test-gateway-server.mjs` | API 端点（chat / models / health / status / backfill） |
| `test-gateway-fallback.mjs` | fallback 链、重试、percentage、异常结构 |
| `test-gateway-web-api.mjs` | 管理服务网关 API |
| `test-gateway-view.mjs` | 前端视图纯函数 |

全部注册进 `test/run-all.mjs`，`prepublishOnly` 绑定 `npm test`。

## 13. 风险

| 风险 | 说明 | 应对 |
|------|------|------|
| 厂商 base_url 约定不一 | 部分已含 `/v1`，拼接可能重复或缺失 | router 统一归一化 |
| 本机网络无法直连 | 原靠 CF 边缘访问的厂商本地不通 | 属预期；Agent 改直连 Worker |
| Key 落本地的攻击面 | 本地需持有真实厂商 Key | 系统级加密，仅当前用户可解密 |
| 流式中途失败 | 200 后 SSE 报错无法回退 | 文档注明，与 CF 一致 |
| 双写一致性 | 云端成功本地失败（或反之） | 本地失败显式告警，提供回填 / 重试 |

## 14. 默认约定

| 项 | 约定 |
|----|------|
| 监听 | `127.0.0.1`（不对外、不鉴权） |
| 默认端口 | `8788`（避开 wrangler 默认 8787） |
| 本地 Agent 配置 | Base URL `http://127.0.0.1:8788/v1` |
| Cloudflare Agent 配置 | Base URL 直连 Worker |
| 模型列表 | 读本地 `data/models.json` |
| 凭证目录 | `~/.ai-gateway-desk/provider-keys/<slug>` |
