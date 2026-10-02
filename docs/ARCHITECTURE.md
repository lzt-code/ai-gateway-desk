# 架构说明

> 项目架构总览。源码为唯一真相，本文描述模块职责、数据模型与关键数据流。
> 由历史开发文档（任务清单 / 交付包 / 需求方案）提炼而成（2026-08-19）。

## 1. 概览

项目由两部分组成：

- **本地管理工具**（`src/`）：Node.js ESM + 本地 Web 界面（Hono + Vanilla JS）。把 Cloudflare REST 全流程自动化——建 gateway → 存 BYOK Key → 建 Custom Provider → 建 KV namespace → 发现模型 → 勾选生成模型列表 → 部署 Worker。
- **转发 Worker**（`ai-gateway-desk-worker/`）：零依赖、无状态 Cloudflare Worker。只做 CORS / 路由 / header 映射（`Authorization` → `cf-aig-authorization`），**真鉴权交给 Cloudflare AI Gateway 自己完成**。

核心设计原则：

| 原则 | 说明 |
|------|------|
| Worker 无凭证 | 厂商 Key 存 AI Gateway（BYOK）；网关 token（`cfut_xxx`）由各客户端请求时携带，Worker 不校验内容不落盘 |
| 唯一真相源 | `data/model-states.json` 持久化全部模型状态与元数据；`data/models.json` 是生成产物 |
| 私有配置不入库 | `data/` 仅白名单 `*.example.json` 模板提交；凭证存用户主目录 `~/.ai-gateway-desk/` |
| 模板永不被污染 | `wrangler.toml` 仅占位符，真实 KV id 由部署时动态注入临时配置（用完即删），git 永远干净 |
| 网页即关闭语义 | 浏览器全部页面关闭后本地服务器自动退出（心跳机制），与桌面应用体验一致 |

## 2. 整体架构

```
┌────────────────────┐   /api/*    ┌───────────────────────────┐   REST     ┌──────────────────────┐
│ 浏览器（本地 Web UI）│ ──────────► │ Hono 服务器（server.js） │ ─────────► │  Cloudflare REST API │
│ Provider/模型/Worker│ ◄────────── │  + sync-flow 编排         │ ◄───────── │  gateway / KV /      │
│ /账户 四视图        │  JSON/SSE   │  + 静态页面 public/       │            │  custom providers    │
└────────────────────┘             └───────────┬───────────────┘            └──────────────────────┘
                                               │ 读写
                                   ┌───────────▼──────────────┐
                                   │ data/（本地运行时数据）     │
                                   │  providers.json  私有配置  │
                                   │  model-states.json 真相源 │
                                   │  models.json     生成产物 │
                                   └───────────┬──────────────┘
                                               │ KV REST 写入（output/deploy.js）
                                               ▼
                                   ┌──────────────────────┐   /v1/chat/completions  ┌──────────────┐
                                   │  Cloudflare KV       │ ◄────────────────────── │  各 PC Agent  │
                                   │  models              │ ───────────────────────► │（统一 Base   │
                                   │  provider-routes     │   GET /v1/models        │  URL + 模型） │
                                   │  provider-visibility │                        └──────────────┘
                                   └──────────┬───────────┘
                                              │ Worker 读 KV + 转发
                                              ▼
                                   ai-gateway-desk-worker（零依赖转发层）
```

## 3. 目录结构

```
ai-gateway-desk/
├── src/                      # 本地管理工具（Node.js ESM）
│   ├── bin/aigd.js     # CLI 入口（web 默认 / gateway / setup / help）
│   ├── setup.js              # 初始化向导（7 步，终端交互）
│   ├── gateway/              # 本地网关（双后端）：server / config-store / router /
│   │                         # provider-keys / provider-lookup / fallback / backends/
│   ├── core/                 # config（providers.json 校验）/ state（model-states）/
│   │                         # routes-store（data/routes.json 动态路由真相源）/
│   │                         # token-store（双凭证安全存储）
│   ├── cloudflare/           # api.js（REST 封装，含 Dynamic Routes 读写）/
│   │                         # kv.js（管理端直读写 KV）/
│   │                         # providers-sync.js（云端列表同步）/ discover.js（模型发现）
│   ├── pipeline/             # enrich（OpenRouter 富化）/ merge（策略 A 状态合并）/
│   │                         # routes-validate（动态路由 elements 校验，纯函数）
│   ├── output/               # generate（models.json）/ deploy（KV 部署 + 路由映射）/
│   │                         # routes-deploy（动态路由 REST 部署编排）
│   ├── web/                  # server.js（Hono + 心跳退出）/ sync-flow.js（四步编排）/
│   │                         # public/（前端五视图，Vanilla JS）
│   └── tui/                  # 纯逻辑模块（render / actions / provider-actions / account-actions）
├── ai-gateway-desk-worker/      # Cloudflare Worker（零依赖转发层）
│   └── src/                  # index.js / http.js / config.js / models-list.js / routes/
├── data/                     # 运行时数据（gitignore，仅 *.example.json 白名单提交）
├── docs/                     # 架构说明（本文）
├── scripts/deploy.mjs        # wrangler 包装：动态注入 KV id 生成临时配置
└── test/                     # 测试（npm test 聚合 test/run-all.mjs）
```

## 4. 模块职责

### 4.1 CLI 入口 — `src/bin/aigd.js`

子命令：`web`（默认，启动本地 Web 界面）、`gateway`（启动本地长驻网关，OpenAI 兼容端点，仅绑 `127.0.0.1:8788`，支持 `--port` / 环境变量 `AIGD_GATEWAY_PORT`）、`setup`（终端初始化向导）。`sync` / `deploy` 为规划占位（Web 界面内已实现同功能）。

### 4.2 初始化向导 — `src/setup.js`

7 步终端引导：管理 API Token → Account ID → 建 gateway → 验证 `cfut_xxx` → 添加 Provider（BYOK 存厂商 Key / 建 Custom Provider）→ 创建 KV namespace → 生成 `data/providers.json`。

输出约定：KV namespace id 回填 `providers.json` 的 `kv.namespaceId`——**唯一数据源**，部署时由此读取。

### 4.3 Web 管理端 — `src/web/server.js`

Hono 应用，`createApp` 支持依赖注入（测试可 mock stateStore / configStore / deps）。心跳自动退出：页面存活期间前端定期上报心跳（3 分钟超时），`pagehide` 加速退出（5 秒宽限）。

| 分组 | 端点 |
|------|------|
| 健康/心跳 | `GET /api/health`、`POST /api/heartbeat` |
| 模型 | `GET /api/state`、`GET /api/models/filtered`、`POST /api/models/{toggle,set-status,remove,batch-toggle,batch-remove,edit,add}` |
| Provider | `GET /api/providers`、`/api/providers/{list,refresh,update,create,delete}` |
| 同步 | `GET /api/sync/progress`（SSE）、`POST /api/sync`、`POST /api/sync/consistency`（第一层一致性同步：只对齐 KV 真相，不 discover）、`POST /api/save`、`POST /api/save-deploy` |
| 调试 | `GET /api/settings/debug`、`POST /api/settings/debug`（详细日志开关，持久化到 providers.json 顶层 `debug` 字段） |
| Worker | `GET /api/workers/status`、`POST /api/workers/deploy` |
| 网关视图 | `GET /api/gateway/overview`、`POST /api/gateway/{start,stop,backfill-keys,provider-key}`（见 §4.12） |
| 账户 | `GET /api/account/status`、`POST /api/account/{update-token,clear-token,setup}` |
| 动态路由配置 | `GET /api/routes/config`、`POST /api/routes/{save,deploy,delete,refresh}`（本地编辑 + REST 部署，见 §4.11） |

### 4.4 前端 — `src/web/public/`

Vanilla JS 单页（`app.js` / `index.html` / `style.css`），五个视图 tab：

- **Provider**：云端+本地合并列表，编辑/隐藏/删除，同步刷新
- **模型**：模型表格 + Provider 侧栏 + 关键字筛选，状态切换（selected/pending/hidden）、编辑、手动添加、批量删除
- **动态路由**：路由表格（fallback 链 / 状态 / 操作），表单化编辑（模板 + 「provider/模型」下拉建议）→ 一键部署（REST），「拉取云端路由」同步展示层
- **网关**：本地网关 / Cloudflare 网关双状态卡片、本地网关「启动 / 关闭」按钮、各 provider 本地凭证状态与「从云端回填 Key」、统一 Base URL 一键复制、手工录入 BYOK Key、部署 Worker
- **账户**：双 token 槽位管理 + gateway 信息 + 初始化向导入口

### 4.5 Cloudflare REST 封装 — `src/cloudflare/`

- `api.js`：统一 `request()`（超时 + 错误归类），按资源分组——AI Gateway（创建/查询）、BYOK provider_configs（增删改查）、Custom Providers（增删改查）、KV namespace 创建
- `kv.js`：管理端直读直写 KV 单键（读 404 返回 null 不抛错），用于跨 PC 同步 `provider-visibility`
- `providers-sync.js`：并行拉取云端 Custom Providers + BYOK 配置，与本地 `providers.json` 合并（策略 A）
- `discover.js`：模型发现，`/v1/models` 或由 pathPrefix 构造列表 URL；`config.debug === true` 时输出每个 provider 的完整请求/响应（终端全文、SSE `status:'debug'` 事件带脱敏请求头与截断响应体预览）

### 4.6 模型管道 — `src/pipeline/` + `src/output/`

- `enrich.js`：OpenRouter + models.dev 双源富化（模块级缓存，仅补缺失字段；pricing 例外——覆盖以跟随上游改价，失败静默）
- `merge.js`：**策略 A：provider 永远覆盖**；仅对成功查询的 provider 执行「未发现 → 直接删除」（manual 条目豁免）
- `generate.js`：过滤 selected + 隐藏 provider（`enabled===false`）的模型 → 写 `data/models.json`
- `deploy.js`：REST 写入部署 models + `provider-routes` 路由映射（slug → pathPrefix），无 wrangler 子进程开销

### 4.7 数据与凭证 — `src/core/`

- `config.js`：加载并强校验 `data/providers.json`（gateway / kv / providers 逐字段断言；顶层 `debug` 可选 boolean）；`setDebugFlag()` 写回 debug 开关（保留其余字段，写前备份 .bak）
- `state.js`：`model-states.json` 读写 + upsert/remove/按状态查询
- `token-store.js`：双凭证槽位（gateway `cfut_xxx` + management 管理 Token），Windows DPAPI / macOS Keychain / Linux 0600 文件，存 `~/.ai-gateway-desk/`；`AI_GW_TEST_DIR` 重定向测试隔离

### 4.8 同步编排 — `src/web/sync-flow.js`

`runSyncFlow` 纯函数：**provider 同步 → discover → merge → enrich** 四步，依赖全部注入，进度经 `onEvent` 外发（server.js 转 SSE）。容错语义：provider 同步失败不中断 discover、discover 无结果不抛错、enrich 失败静默、enrich 的 pricing 覆盖后回写 provider 自报价格（provider 价格优先于富化源）、merge 深拷贝不改原 state。

### 4.9 TUI 目录 — `src/tui/`

UI 已迁移至 Web（2026-08-10），目录保留**纯逻辑模块**供 API 层复用：`render.js`（视图渲染）、`actions.js`（同步/保存编排）、`provider-actions.js`（云端参数组装）、`account-actions.js`（token 槽位/Worker 状态汇总）。

### 4.10 Worker — `ai-gateway-desk-worker/src/`

| 文件 | 职责 |
|------|------|
| `index.js` | CORS 预检（动态回显请求头）+ 路由判定，无业务逻辑 |
| `routes/chat.js` | 解析 model 的 provider slug：命中 `provider-routes` → 走 provider-specific 端点（剥离 slug 前缀，URL 已含 slug）；否则 compat 端点（保留 slug） |
| `routes/models.js` | KV `models` 键 → `{ object: 'list', data }`，KV 缺失回退默认空列表；公开端点（不带 Authorization） |
| `config.js` | env 读取 `ACCOUNT_ID` / `GATEWAY_ID` / `GW_HOST`（后两者缺失抛错，友好 500） |
| `models-list.js` | KV 未设置时的兜底默认模型列表（空） |

核心映射：`Authorization: Bearer <token>` → `cf-aig-authorization`（原样透传），删除原 `Authorization`。Body 流式直传，不缓冲。

### 4.11 动态路由配置 — `src/core/routes-store.js` + `src/pipeline/routes-validate.js` + `src/output/routes-deploy.js`

本地配置动态路由（绕开 Cloudflare 画布编辑器），部署走管理 REST API：

| 模块 | 职责 |
|------|------|
| `routes-store.js` | `data/routes.json` 读写（本地真相源，CF 原生 elements 格式 1:1 存取，可双向同步） |
| `routes-validate.js` | elements 图本地校验（纯函数）：start/end 约束、连线悬挂、percentage 权重和、model/rate/conditional 必填字段 |
| `routes-deploy.js` | 部署编排（API 函数可注入）：创建路由壳（409 → 列表查回 id）→ `POST versions` 提交图 → `POST deployments` 生效；cloudId 失效（404）自动重建重试 |

`server.js` 端点与数据流：

```
POST /api/routes/save     本地保存（服务端校验 elements，dirty=true，不触网）
POST /api/routes/deploy   编排部署（缺省全部 dirty；成功回写 cloudId/deployedVersion/dirty=false）
POST /api/routes/refresh  云端覆盖本地（elements 取详情 version.data，dirty 归零）
POST /api/routes/delete   本地必删；cloud=true 且有 cloudId 时同步删云端（404 视为成功）
```

关键决策：**数据格式 1:1 采用 Cloudflare 原生 JSON**（GET versions 读回即同构，云端↔本地 round-trip 不丢信息，无转换层）；编辑器双模式——**表单模式默认**（模板提供骨架 + spec↔elements 互转纯函数 `routeSpecFromElements` / `elementsFromRouteSpec`，模型字段用「provider/模型名」格式并带 model-states 下拉建议；**fallback 链支持任意级数**，与 Cloudflare 原生一致，表单内逐级增删，链外孤儿/成环结构降级 JSON），**JSON 模式兜底**（组合节点等超出表单能力的结构自动降级）。

### 4.12 本地网关 — `src/gateway/`（本机出口 IP 直发）

默认调用链走 Cloudflare：

```
Agent → 云端 Worker（ai-gateway-desk-worker）→ Cloudflare AI Gateway → AI 厂商
```

Cloudflare AI Gateway 的出口 IP 在其全球边缘节点，是大量用户共享的 IP 段。部分 AI Provider 会对这类共享 IP 做风控，导致高频调用时容易收到 `429 Too Many Requests`，即使自身 Key 额度充足也会被误伤。**本地网关**让请求从用户本机出口 IP 直发厂商，绕开共享 IP，降低 429 概率。

#### 4.12.1 两条路线如何共存（决策）

| 路线 | Agent Base URL | 出口 IP | 适用 |
|------|----------------|---------|------|
| 本地网关 | `http://127.0.0.1:8788/v1` | 用户本机 IP | 规避共享 IP 的 429 |
| Cloudflare | 云端 Worker 地址（直连） | Cloudflare 边缘共享 IP | 需要 analytics / 缓存 / 预算限流，或本机网络无法直连厂商 |

**关键决策**：Cloudflare 路线由 Agent **直接指向 Worker URL**，本地网关不再充当转发跳。早期曾设计「cloud 模式下本地网关作为隧道」，但该跳不带来协议增益（不解决 429、不改善 workers.dev 可达性），Agent 本可直连 Worker，故移除。本地网关只做一件事：本机出口 IP 直发。Worker 本身保持零依赖、无状态，无需为本地网关做任何改动。

#### 4.12.2 目标与非目标

目标：

1. 提供 `aigd gateway` 长驻进程，对外提供 OpenAI 兼容端点（仅绑 `127.0.0.1`）。
2. 解析模型的 provider slug → 取本机加密凭证 → 本机出口 IP 直连厂商，流式透传。
3. 支持本地动态路由 fallback 链（复用 `data/routes.json`）。
4. 与 Cloudflare 路线共用同一套 Provider / 模型 / 路由配置，凭证可云端回填。

非目标：

1. 不做本地网关到云端 Worker 的转发 / 隧道。
2. 不做按 Provider 粒度的路由分流（本地 / 云端二选一，由 Agent Base URL 决定）。
3. 不监听局域网、不做远程多 PC 共用。
4. 不复制 Cloudflare 的 analytics / 缓存 / 预算限流。
5. 不集成 Portkey（理由见 §4.12.9）。

> 早期（v1）网关仅由独立终端 `aigd gateway` 启动；当前管理界面「网关」页可一键启动 / 关闭，但网关始终是**独立进程**（detached spawn，见 §4.12.7），界面只做编排与状态探测，不做托管。

#### 4.12.3 整体架构与请求流

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

```
Agent → 本地 gateway
  → 解析 body.model 中的 provider slug（要求 model 形如 '<slug>/<模型名>'）
  → 从本地加密存储取该 provider 的凭证 headers
  → 取 providers.json 中该 provider 的 base_url（+ pathPrefix）
  → 构造厂商真实端点，本机出口 IP 直连
  → 流式透传响应
若 model 为 dynamic/<name> → 进入本地 fallback 引擎（见 §4.12.5）
```

#### 4.12.4 模块与端点

| 模块 | 职责 |
|------|------|
| `server.js` | `createGatewayApp(deps)` Hono 工厂（全依赖注入）+ `startGateway()` 启动器（`@hono/node-server`，仅绑 127.0.0.1、无心跳退出、EADDRINUSE 友好提示、`/api/gateway/shutdown` 关闭钩子） |
| `process.js` | 管理界面侧进程编排：detached + `unref()` spawn `aigd gateway`（新进程组，脱离管理界面与终端）、轮询 `/health` 等待就绪、请求 `/api/gateway/shutdown` 优雅关闭、回读 `data/gateway.log` 尾部 |
| `config-store.js` | `data/gateway.json` 读写与校验：仅 `port`（默认 8788）；读取时忽略旧 `mode` / `cloudWorkerUrl` 字段 |
| `router.js` | 纯函数：model slug 解析 / 剥离、base_url + pathPrefix 厂商端点构造；内置常见 BYOK slug 的 OpenAI 兼容 base_url 映射 |
| `provider-keys.js` | 按 provider slug 在 `~/.ai-gateway-desk/provider-keys/<slug>` 存完整鉴权 headers（复用 token-store 系统级加密；`AI_GW_TEST_DIR` 隔离） |
| `provider-lookup.js` | gateway slug → `providers.json` 条目查找 |
| `backends/local.js` | `LocalBackend`：取本地凭证 → 本机出口 IP 直发厂商，超时控制、流式透传；`dynamic/*` 委托 fallback 引擎 |
| `fallback.js` | 本地动态路由引擎：执行 `routes.json` elements——线性 fallback 链 + `percentage` 权重；`conditional` / `rate` 明确报错（该结构仅 Cloudflare 支持，请直连 Worker） |
| `response-util.js` | 上游响应归一化：把 undici 的 `headers.guard=immutable` 响应转为可写响应，修正已解压 / 逐跳响应头，供 CORS 中间件安全补头 |

网关端点（`server.js`）：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 进入 `LocalBackend` |
| `/v1/models` | GET | 读本地 `data/models.json`，包装为 `{ object:'list', data }` |
| `/health` | GET | 网关进程存活 + backend 健康 |
| `/api/gateway/status` | GET | 端口、各 provider 本地凭证状态 |
| `/api/gateway/shutdown` | POST | 管理界面关闭本进程（先应答再优雅退出；拒绝带 `Origin` 的浏览器请求） |
| `/api/gateway/backfill-keys` | POST | 从云端拉 custom-provider 完整 key 回填本地 |

CORS 与 Worker 一致，动态回显预检所需头。`/api/gateway/shutdown` 的关闭钩子由 `startGateway` 在 server 就绪后注入（关 server → `process.exit(0)`，2s 兜底强退）；未注册钩子（如测试直接 `createGatewayApp`）返回 501。

#### 4.12.5 本地动态路由 fallback 引擎 — `src/gateway/fallback.js`

执行语义（对齐 Cloudflare）：

1. 从 `start` 进入首个 `model` 节点。
2. 每个 `model` 节点按 `timeout` / `retries` 调用对应 provider 的本地直发。
3. 可重试错误（网络失败 / 429 / 5xx）重试耗尽后走 `fallback` 边。
4. 收到 200 即成功并开始流式返回；4xx（非 429）立即报错。
5. 支持 `percentage` 随机权重。
6. `conditional` / `rate` / 组合节点返回明确错误：该结构仅 Cloudflare 支持，请让 Agent 直连 Worker。

限制：**流式开始后无法回退**（上游 200 后 SSE 中途出错不能切换，Cloudflare 同理）。

#### 4.12.6 凭证策略

- 存储：复用 `src/core/token-store.js` 系统级加密原语（Windows DPAPI / macOS Keychain / Linux 0600 文件），在 `~/.ai-gateway-desk/provider-keys/<slug>` 存完整 headers 对象（兼容自定义鉴权头）。测试通过 `AI_GW_TEST_DIR` 隔离。

| 类型 | 云端可读回完整 key | 处理 |
|------|--------------------|------|
| custom-provider | **可以**：`listCustomProviders` 的 `headers` 为完整未脱敏字符串 | 自动回填，用户无感 |
| byok | **不可以**：仅返回 `secret_preview` 掩码 | UI 重新录入一次 |

自动回填前置：本地存有管理 API Token；无 Token 时 UI 降级提示手工录入。新增 / 覆盖 / 删除 Provider 时，在写云端之外同步写 / 删本地加密存储（录入即双写）；本地写失败需明确告警但不阻断云端结果。

#### 4.12.7 管理界面启停 — `src/gateway/process.js`

管理界面与本地网关是两个进程，二者唯一耦合是 `data/gateway.json` 的端口：

| 动作 | 实现 |
|------|------|
| 启动 | 管理界面 detached + `unref()` spawn `node src/bin/aigd.js gateway --port <port>`（新进程组、`windowsHide`），再轮询 `/health` 直至就绪；子进程提前退出（如端口被占用）立即失败并回读 `data/gateway.log` 尾部作为错误详情 |
| 关闭 | `POST /api/gateway/shutdown`（不带 `Origin`），网关先应答 200 再关 server + 退出（2s 兜底强退）；管理界面轮询 `/health` 确认端口已释放 |
| 探测 | `GET /health`，且仅认 `{ ok:true, backend:{...} }` 结构（端口被其他程序占用 → 视为未运行） |

- 网关进程脱离管理界面：关闭 / 重启管理界面（含终端 Ctrl+C）不影响网关；管理界面重启后按 `gateway.json` 端口重新探测即可恢复运行状态。
- 不做 PID 文件管理（避免 PID 复用误杀），只在管理界面已有 PID 之外通过 HTTP 关闭；网关若由终端 `aigd gateway` 启动，UI 同样能探测并关闭。
- 管理界面 API：`POST /api/gateway/start`（已运行 → 幂等 `alreadyRunning`）、`POST /api/gateway/stop`（未运行 → 幂等 `alreadyStopped`）；业务失败（端口占用 / 就绪超时 / 关闭超时）仍 200，带 `error` 字段。
- 回填 / 凭证录入均在管理进程直接写本地加密存储，与网关进程是否在跑无关。

#### 4.12.8 Cloudflare 地址发现

由「网关」视图通过 Cloudflare API 自动发现（`discoverWorkerEndpoints`，聚合在 `GET /api/gateway/overview`），覆盖三类绑定：

- workers.dev 默认地址：账户子域（`GET /workers/subdomain`）+ 脚本开关（`GET /workers/scripts/{name}/subdomain`）；
- Custom Domains：`GET /workers/domains`；
- Workers Routes（zone 路由）：`GET /zones` + `GET /zones/{id}/workers/routes`，路由模式（如 `*.example.com/api/*`）转换为 Agent Base URL；host 含通配符时以 `<子域>` 占位提示替换。

地址仅用于展示与引导 Agent 直连，本地网关不会请求，也不本地存储（旧 `gateway.workerUrl` 字段不再读取）。

**Workers Routes 的 `<子域>` 自动解析**：路由模式 host 含通配符（如 `*.example.com/api/*`）时，会进一步调用 `GET /zones/{id}/dns_records?proxied=true` 自动解析真实子域：

- 管理 Token 需具备 **Zone → DNS → Read**（列 zone 仍用 Zone → Zone → Read）；
- 有具体已代理（橙云）子域记录 → 逐个给出可用 Base URL（替换 `<子域>`）；
- 仅有 `*` 通配代理记录 → 保留 `<子域>` 占位并提示「任意子域可用」；
- 无匹配记录 → 保留占位并提示先添加代理 DNS 记录；
- DNS 接口 403（Token 无权限）→ 保留占位并提示补充 DNS Read 权限。

提示经 `discoverWorkerEndpoints` 的 `notes` 字段返回、在前端网关卡以警告展示；单点失败不中断其他发现，也不计入 `error`。Token 权限只能在 Cloudflare 面板手动编辑（API 无法自改），Token 字符串不变。

#### 4.12.9 为什么不集成 Portkey

1. `@portkey-ai/gateway` 仅暴露 `bin`，未导出可 import 的 app 入口；源码集成需 TS 工具链或维护 fork。
2. 带来 14 个依赖（ioredis、avsc、smithy、ws 等）与 `patch-package`，与克制的依赖风格冲突。
3. 现有 provider 均为 OpenAI 兼容，Portkey 的多协议转换 / guardrails 大部分用不上。

核心诉求是换出口 IP，自建薄层即可满足。

#### 4.12.10 默认约定与风险

| 项 | 约定 |
|----|------|
| 监听 | `127.0.0.1`（不对外、不鉴权） |
| 默认端口 | `8788`（避开 wrangler 默认 8787） |
| 本地 Agent 配置 | Base URL `http://127.0.0.1:8788/v1` |
| Cloudflare Agent 配置 | Base URL 直连 Worker |
| 模型列表 | 读本地 `data/models.json` |
| 凭证目录 | `~/.ai-gateway-desk/provider-keys/<slug>` |

| 风险 | 说明 | 应对 |
|------|------|------|
| 厂商 base_url 约定不一 | 部分已含 `/v1`，拼接可能重复或缺失 | router 统一归一化 |
| 本机网络无法直连 | 原靠 CF 边缘访问的厂商本地不通 | 属预期；Agent 改直连 Worker |
| Key 落本地的攻击面 | 本地需持有真实厂商 Key | 系统级加密，仅当前用户可解密 |
| 流式中途失败 | 200 后 SSE 报错无法回退 | 文档注明，与 CF 一致 |
| 双写一致性 | 云端成功本地失败（或反之） | 本地失败显式告警，提供回填 / 重试 |
| 网关成为孤儿进程 | 网关刻意独立于管理界面，管理界面退出后它仍占用端口 | 属预期：UI「关闭网关」或终端 Ctrl+C 结束；重启管理界面仍能探测到并关闭它 |

## 5. 数据模型

### 5.1 `data/providers.json`（私有，gitignore）

```json
{
  "gateway": { "host", "accountId", "gatewayId" },
  "kv": { "namespaceId", "key": "models" },
  "providers": [ { "id", "name", "type": "byok|custom-provider", "enabled", "pathPrefix?", ... } ]
}
```

### 5.2 `data/model-states.json`（真相源，gitignore）

```json
{ "modelId": { "status": "selected|pending|hidden", "provider": "...", "metadata": { ... } } }
```

状态机：

```
          发现新模型
               │
               ▼
            pending ──采用──► selected ──隐藏──► hidden ──取消隐藏──► selected
               │                  │                ▲                      │
               │ 忽略              │ provider 不再返回 │                      │
               ▼                  ▼                │                      │
            hidden          从 state 删除 ◄─────────┘（同步时直接物理删除，
                              │     manual 条目豁免；也可手工删除）
                              │
                       （pending/hidden 消失亦同理物理删除）
```

- `selected`：写入 models.json，出现在 `/v1/models`
- `pending`（待审）：新发现模型默认态。不进 models.json、不进任何 KV 键，
  不触发同步后的自动部署。用户在「待审」筛选中采用（→ selected）或忽略（→ hidden）。
  跨 PC 收敛：每台 PC 独立发现新模型即标 pending，无需传播；采用/忽略经 KV
  （selected → models 键 / hidden → hidden-models 键）跨 PC 同步
  （applySelectedModels 提升 + 取消隐藏归位）
- `hidden`：跨更新保持隐藏，不入列表；同步不会删除
  隐藏集合发生增删时（toggle / set-status / batch-toggle 改了隐藏成员）即时重写
  `hidden-models` KV，使「本地隐藏但尚未部署」的决策立刻上云，避免同步时的取消隐藏
  归位误伤；隐藏成员未变的状态流转（如待审采用 pending → selected）不写该键——
  写入是本地快照全量覆盖，无变化的重写只会抹掉本机尚未同步到的远端隐藏决策。
- 删除：无中间态，provider 不再返回时同步直接物理删除（手工模型需手工删除）

### 5.3 `data/models.json`（生成产物，gitignore）

由 generate 过滤 **selected**（pending/hidden 不入）+ 隐藏 provider 后输出数组，直接部署到 KV。

### 5.4 `data/routes.json`（私有，gitignore）

动态路由本地真相源（见 §4.11）。`routes[name]` 条目：

```json
{
  "name": "support",
  "elements": [ ...CF 原生流程图节点（start/conditional/percentage/model/rate/end）... ],
  "cloudId": "云端路由 UUID（首次部署后回填）",
  "deployedVersion": 3,
  "dirty": true,
  "lastDeployedAt": "ISO 时间戳",
  "lastSyncedAt": "ISO 时间戳"
}
```

调用侧：各 PC Agent 请求 model 填 `dynamic/<name>`，Worker 原样透传到 compat 端点（`routes/chat.js` 的 slug 解析不命中 provider-routes，走默认 compat）。

### 5.5 `data/gateway.json`（私有，gitignore）

本地网关运行配置（模板 `data/gateway.example.json`）：

```json
{ "port": 8788 }
```

`port`：正整数 1–65535，默认 8788。旧文件中的 `mode` / `cloudWorkerUrl` 字段在读取时被忽略（本地网关不再有「模式」概念，Cloudflare 路线由 Agent 直连 Worker）。

## 6. 凭证架构

| 凭证 | 作用域 | 用途 | 位置 |
|------|--------|------|------|
| 管理 API Token | 账户级 | 建 gateway、存 BYOK、建 KV、部署 | `token.management` 槽位 |
| 网关 token（`cfut_xxx`） | 单 gateway | 模型发现 + 分发给各 PC | `token` 槽位 |
| 本地 provider 鉴权 headers | 本机 | 本地网关直发厂商（完整请求头，兼容自定义鉴权） | `~/.ai-gateway-desk/provider-keys/<slug>` |

优先级：环境变量（`CLOUDFLARE_API_TOKEN` / `GATEWAY_TOKEN`）> 本地安全存储。管理 Token 账户级凭证不可分发；`cfut_xxx` 泄露影响面仅限其绑定的 gateway。

> 账户页对管理 Token 做自检：`/user/tokens/verify` 取当前令牌 id，`/user/tokens`（需 `User → API Tokens → Read`）取名称与 policies，逐条比对所需权限（AI Gateway / Workers Scripts / KV Edit 等）并列出缺失项。所需权限清单为静态数据（由 `/api/account/status` 返回），未配置令牌或权限读取失败时表格仍完整展示，用户据此创建/补充。

### 6.1 Provider 厂商 Key 的两种存储方式

> 2026-08-22 补充。本工具（aigd）与 Cloudflare 网页对 provider key 的写入路径不同，**存储后端不一致**——两者都落在 Cloudflare 云端，但一个存进 Secrets Store、一个内联在 provider_configs / custom-provider 的 `headers` 里。因此「在 Cloudflare 管理界面能否看到 key」取决于配置来源。

| 配置途径 | 存储位置 | 是否在 CF 管理界面可见 | 实现代码 |
|---------|---------|----------------------|---------|
| Cloudflare 网页「Provider Keys」（BYOK） | **Secrets Store**，secret 命名 `{gateway_id}_{provider_slug}_{alias}`（如 `cf-ai-gateway_openai_default`），由网页自动创建 | 可见（Provider Keys 列表：last used / status 等） | 网页内部自动建 secret + provider_config |
| aigd BYOK | `provider_configs` 记录**内联 `secret`** + `default_config: false` | 不可见（未按官方流程先建 Secrets Store secret，且非默认配置） | `src/cloudflare/api.js` `createProviderConfig`（POST `/provider_configs`） |
| aigd Custom Provider | custom-provider 记录的 **`headers`** 字段（`Authorization: Bearer ...`，JSON 字符串；API 接受但官方文档未收录） | 不可见（dashboard 创建/编辑界面只有 name / slug / base_url，无 headers 字段） | `src/cloudflare/api.js` `createCustomProvider`（POST `/custom-providers`） |

关键点：

1. **运行时取 key**：AI Gateway 默认使用 alias 为 `default` 的 BYOK key（`cf-aig-byok-alias` 头可选其它 alias）。aigd 写 BYOK 时 alias 默认 = provider_slug 且 `default_config: false`，**该 key 运行时是否真被网关选中需单独验证**。当前 `data/providers.json` 全为 custom-provider（key 在 `headers` 里），实际走的就是 headers 路径。
2. **官方 API 流程**（若要让 key 在 dashboard 可见、可轮换、有状态监控）：先建 Secrets Store secret（命名 `{gateway_id}_{provider_slug}_{alias}`），再建 provider_config；或直接在 dashboard 配置。
3. **对 Worker 无影响**：Worker 是无状态转发层，**不读取任何 provider key**——无论 key 存在 Secrets Store 还是 provider_configs / headers，运行时都由 Cloudflare AI Gateway 持 key 调上游，Worker 只透传 `cf-aig-authorization`（见 §7.3）。

## 7. 核心流程

### 7.1 同步（Web「一键同步」或 `POST /api/sync`）

1. provider 同步：云端的 Custom Provider / BYOK 变更合并进本地配置（无管理 Token 则跳过）
2. discover：遍历 provider 拉取模型列表
3. merge：策略 A 合并，产生新增/消失/变更摘要
4. enrich：OpenRouter 补全新模型缺失字段 → 应用 KV 真相（手工/隐藏/已部署）→ 保存 state → 生成 models.json

**分层启动（打开页面时）**：为避免重型 discover 全局阻塞启动，前端启动链拆为两层——

- **第一层「一致性同步」**（`POST /api/sync/consistency`，秒级）：只读 KV 四键
  （visibility / hidden-models / manual-models / models）应用到 state 与 provider enabled，
  不重拉模型；完成后即解锁 UI。跨 PC「用户决策」冲突面全部在这一层收敛。
- **第二层「发现刷新」**（`POST /api/sync`，后台非阻塞）：受前端 TTL（`DEFAULT_DISCOVER_TTL_MS`，
  默认 30 分钟，记录于 localStorage）约束，距上次成功发现过久才自动跑；运行期间 UI 可继续操作。
- **本地优先合并**：`/api/sync` 记录同步起点的 `stateVersion` 与状态快照；若发现期间用户改过
  模型（状态/元数据/新增/删除），同步结束前把窗口内的本地改动重放到合并结果之上，避免被
  discover/KV 结果覆盖（改动随后由自动部署统一收敛）。

### 7.2 部署（`POST /api/workers/deploy` 或 `npm run deploy`）

`scripts/deploy.mjs` 从 `providers.json` 读真实 KV namespace id，注入 `wrangler.toml` 模板生成 `.wrangler.generated.toml`（用完即删），再执行 `wrangler deploy`。**模板文件永不被修改**。

### 7.3 请求转发（Worker）

```
客户端 POST /v1/chat/completions
  → 提取 model 中 provider slug
  → 命中 provider-routes？→ 上游 URL 改为该 provider 的 pathPrefix 端点（model 剥离 slug 前缀）
  → 未命中 → AI Gateway compat 端点（保留 slug）
  → 映射 Authorization → cf-aig-authorization，body 流式直传
```

## 8. 关键设计决策

| 决策 | 理由 |
|------|------|
| Worker 零依赖、无凭证 | 部署即用，泄露 URL 也无凭证可拿；真鉴权在 AI Gateway 层（可设日预算/限流） |
| 本地管理工具 + Worker 解耦 | 管理工具只通过 KV namespace id 与 Worker 关联，可独立演进 |
| 本地网关只直发、不做隧道 | Cloudflare 路线 Agent 直连 Worker，中转无协议增益；本地网关专注换出口 IP，Worker 无需改动（见 §4.12.1） |
| model-states.json 唯一真相源 | 元数据首次填充后永久保留，重新发现不丢失手动编辑 |
| 策略 A（provider 永远覆盖） | provider 更新（如上下文窗口扩大）是正常现象，手动覆盖被覆盖可接受 |
| wrangler.toml 占位符 + 部署时注入 | 真实值唯一存放于 gitignore 的 providers.json，git 永远干净 |
| 纯函数 + 依赖注入（web server / sync-flow） | 全部业务逻辑可单测，测试不触网不落盘 |
| 价格展示按数据源区分单位/币种 | 扁平 pricing 无元数据（量级启发式 + USD 假设），结构化 pricings 读显式 unit/currency，详见 §8.1 |

### 8.1 价格字段：单位与币种

metadata 中的价格有两种形态，单位与币种不统一：

| 形态 | 来源 | 元数据 |
|------|------|--------|
| 扁平 `pricing`：`{prompt, completion}` 等数字/字符串 | provider 自报回写（sync-flow）或 OR/MD 富化 | **无** unit/currency；实测 per-token 与 per-M 混存（如 `5e-6` 与 `5` 同为 $5/M） |
| 结构化 `pricings`：`{prompt: [{value, unit, currency}]}` 数组 | provider 自报 | **显式** `unit`（perMTokens/perCount/perSecond）与 `currency`（实测全为 USD） |

**展示层换算（已实现**，`src/web/public/app.js` 的 `formatPriceDisplay`，用于同步变更明细表格**）**：

- 结构化数组：读显式 `unit`/`currency` —— perMTokens 值原样展示（不 ×1e6），perSecond/perCount 等按原单位；币种 USD→`$`、CNY/RMB→`¥`、未知用代码前缀、缺失按 USD 假设；多档价合并为 `$0.66 / $1.32 /M tokens`
- 扁平数值：无元数据，按 USD 假设 + 量级启发式 —— `≥0.005` 判 per-M（provider 原样），否则判 per-token ×1e6（OR/MD 富化语义）。阈值依据实测分布：per-token 最大 1e-5（$10/M）、per-M 最小 0.05（$0.05/M），0.005 居中留双侧数量级余量
- 非 token 计价子字段（`pricing.audio`/`image`/`web_search` 等按次/按秒计价）：不做换算，原样展示

已知盲区（扁平形态无元数据，不可根除）：真·per-token ≥0.005（≥$5000/M）或真·per-M <0.005 的极端价格会被误判；扁平价格币种完全依赖 USD 假设。

**币种交叉验证（诊断方案，未实现为代码）**：provider 无币种元数据时，可将其价格与 OpenRouter / models.dev 参考价（均 USD，同步管线内 enrich 阶段已在场）做比率比对：

- prompt/completion 双侧比率一致且 ≈1 → 判 USD
- 双侧比率一致且落在汇率带（6–8.5x）→ 疑似 CNY
- 配套「provider 内币种一致」假设（计价币种是 provider 账单级属性，非模型属性）传播锚点：provider 内已验证模型可覆盖同 provider 未命中参照的模型

2026-09 临时脚本实测（未入库，按上述方法可重写）：238 个可对比模型、5 个 provider（opencode/zenmux/qwen-tp/mo-da/bai）中位比率均为 1.00，**零 CNY 嫌疑**；离群点均为渠道加价/折扣（0.6–3.5x，双侧比率一致）。注意事项：魔搭类 provider 模型名为驼峰（`Qwen/Qwen3-14B`），与 OR 小写 id 比对需大小写归一；模型不在 OR/MD 上的 provider（自研模型）无外部参照，只能靠量级判断。

**若未来出现 CNY provider**：推荐在 `providers.json` 增加 provider 级 `priceCurrency` 显式配置（确定性判定），优于把统计推断做成运行时逻辑——比较窗口仅在同步瞬间（provider 回写覆盖富化参考价，metadata 最终只留一份），判定结果需新增字段存储，且「统一加价 ≡ 汇率换算」在数值上不可区分。

## 9. 测试策略

`npm test` 聚合 `test/run-all.mjs` 下全部测试：纯逻辑单测（筛选/表格/合并/状态/凭证槽位）、API 端点测试（Hono `app.request()` 模拟 HTTP，mock fetch / fs / DB）、CLI 接线测试。测试隔离原则：`AI_GW_TEST_DIR` 重定向凭证存储、mock 依赖注入、不触真实网络与文件。测试文件清单见 §13。

---

# 操作指南（面向使用者）

> 上文 §1–§9 为架构与实现参考；本节为实操入口，合并自原 README。

## 10. 快速开始

### 10.1 安装

```bash
npm install -g ai-gateway-desk
```

（也可在仓库目录 `npm install` 后用 `npm run web` 启动。）

### 10.2 首次使用

```bash
# 启动本地 Web 管理界面（默认子命令，启动后自动打开浏览器）
aigd web
# 等价于：node src/bin/aigd.js web（不带子命令时默认即 web）

# 首次使用前先运行初始化向导（管理 Token → Account ID → 建 gateway → cfut_xxx → provider → KV）：
aigd setup
```

> 关闭语义与桌面应用一致：浏览器页面全部关闭后本地服务器自动退出（默认 15 秒心跳超时；页面关闭瞬间通过 `pagehide` 发送的 goodbye 信号可将退出提前到约 5 秒内）。期间刷新页面不会误退出；纯 API / 从未打开页面的场景不自动退出，按 `Ctrl+C` 手动结束。

### 10.3 前置条件（需手动完成两次 Cloudflare 操作）

1. 在 Cloudflare Dashboard 创建**管理 API Token**（账户级，用于建 gateway / 存 BYOK / 建 KV / 部署）。
2. 创建 gateway 的认证 token `cfut_xxx`（权限选 **Run**），用于模型发现与分发给各 PC Agent。

其余全部由 Web 管理界面通过 Cloudflare REST API 自动完成（建 gateway、存厂商 Key、建 Custom Provider、建 KV namespace、发现模型、生成模型列表、部署 Worker）。

## 11. Web 管理界面操作

启动后浏览器自动打开 `http://localhost:<端口>`，顶部选项卡切换四个视图（模块实现见 §4.3 / §4.4）：

| 视图 | 功能 |
|------|------|
| Provider | 云端 Provider 列表（合并本地缓存）：编辑（slug 只读 / name 可改 / api key 仅覆盖不查看 / 云端启用 / 本地参与发现）、删除（云端 + 本地同步）、刷新 |
| 模型 | 模型表格（模型ID / Provider / 上下文 / 状态 四列）：Provider 侧栏与关键字筛选、状态切换、同步云端、保存并提交 |
| 网关 | 本地网关卡（运行状态 / 监听地址 / Base URL 复制 / 启动 · 关闭按钮）+ Cloudflare Worker 卡（自动发现地址、部署 Worker）+ 各 Provider 本地凭证表（回填 / 录入 / 覆盖） |
| 账户 | 双 token 槽位管理（管理 API Token / Gateway Token）+ 管理 Token 名称与所需权限自检 + gateway 信息，初始化向导入口 |

> 管理 Token 获取顺序：环境变量 `CLOUDFLARE_API_TOKEN` > 本地安全存储；缺失时 Provider 拉取降级为只读本地缓存。

## 12. Worker 部署

`ai-gateway-desk-worker/wrangler.toml` 是**占位符模板**，不含任何私有值（`account_id` 已移除、KV id 为占位符 `<YOUR_KV_NAMESPACE_ID>`）。真实 KV namespace id 唯一存放在 `data/providers.json` 的 `kv.namespaceId`，`npm run dev` / `npm run deploy` 时由 `scripts/deploy.mjs` 动态注入生成临时配置（用完即删），**模板本身永不被修改**（git 保持干净）。部署编排见 §7.2。

```bash
# 1. 部署上下文（二选一）：
npx wrangler login                        # 交互式登录
# 或 export CLOUDFLARE_ACCOUNT_ID=<你的账号ID>   # CI 场景

# 2. 准备 KV namespace id（二选一）：
aigd setup                    # 推荐：向导第 6 步自动创建 KV 并回填 data/providers.json
# 或手动创建后填入 data/providers.json 的 kv.namespaceId：
#   npx wrangler kv:namespace create MODELS_KV

# 3. 设置 Gateway 配置（必填，secret 或 wrangler.toml [vars]）
npx wrangler secret put ACCOUNT_ID
npx wrangler secret put GATEWAY_ID

# 4. 本地开发 / 生产部署（自动注入 KV id，模板不被修改）
npm run dev
npm run deploy
```

部署成功后，Worker 自动获得 Cloudflare 分配的 `*.workers.dev` 子域地址（无需额外配置）：

```
https://ai-gateway-desk-worker.<你的Workers子域>.workers.dev
```

- `<你的Workers子域>` 是账户级子域，在 **Workers & Pages → 右上角「你的子域」** 查看（形如 `my-account`，仅首次设置）。
- 此地址即各 PC Agent 的 OpenAI `base_url`，完整端点（实现见 §4.10）：
  - `POST /v1/chat/completions` — 转发到 AI Gateway（`cf-aig-authorization` 头透传，移除原始 `Authorization`）
  - `GET /v1/models` — 从 KV 读取模型列表

> `*.workers.dev` 在部分网络环境下可能被 DNS 污染 / 不可达（见 §12.1）。如需稳定访问，建议绑定自己的域名。

Worker 是零依赖薄转发层，提供 OpenAI 兼容端点（实现见 §4.10）：

- `POST /v1/chat/completions` — 转发到 AI Gateway（`cf-aig-authorization` 头透传，移除原始 `Authorization`）
- `GET /v1/models` — 从 KV 读取模型列表

### 12.1 访问地址与自定义域名绑定

#### 默认访问地址

部署成功后，Worker 自动获得一个 `*.workers.dev` 子域地址（无需额外配置）：

```
https://ai-gateway-desk-worker.<你的Workers子域>.workers.dev
```

`<你的Workers子域>` 是 Cloudflare 账户级子域，在 **Workers & Pages → 右上角「你的子域」** 查看（形如 `my-account`，仅首次设置）。各 PC Agent 的 OpenAI `base_url` 填这个地址即可。

#### 为什么需要绑定自己的域名（DNS 污染）

`*.workers.dev` 是 Cloudflare 的共享域名，**在中国大陆等部分网络环境下会被 DNS 污染 / 限速，导致 Agent 调用超时或完全不可达**；共享域名还可能受 Cloudflare 的速率或合规策略连带影响。

解决思路：**把你自己拥有、且 DNS 已托管在 Cloudflare 的域名绑定为 Worker 的专属访问地址**（例如 `aigw.your-domain.com`）。这样 Agent 的 `base_url` 不再是 `*.workers.dev`，而是你可控的域名，从而规避共享域名被污染的问题。

#### 方式一：Custom Domain（推荐，SaaS 式专属主机名）

1. **Workers & Pages** → 选中你的 Worker → **Triggers** → **Custom Domains** → **Add Custom Domain**
2. 输入子域，例如 `aigw.your-domain.com`（该域名的 zone 必须已托管在 Cloudflare）
3. Cloudflare 自动添加 `aigw` 的 CNAME 指向 Worker，并自动签发证书
4. 之后 Agent 的 `base_url` 改为 `https://aigw.your-domain.com`

> Custom Domain 把整个子域独占给该 Worker，路径干净（直接 `/v1/chat/completions`），最适合做 OpenAI 兼容 Base URL。

#### 方式二：Route（兼容老方式）

```bash
npx wrangler routes create "your-domain.com/*" --name=ai-gateway-desk-worker
# 查看现有路由
npx wrangler routes list --name=ai-gateway-desk-worker
# 删除旧路由
npx wrangler routes delete "old-domain.com/*" --name=ai-gateway-desk-worker
```

Route 要求 `your-domain.com` 所在 zone 已托管在 Cloudflare，请求到达该 zone 后按路由转发给 Worker。

#### 进阶：国内可达性

即便绑定自有域名，流量仍走 Cloudflare 全球 Anycast，在国内的回程质量仍可能不稳定。如需面向中国大陆用户提供稳定低延迟访问，可考虑 Cloudflare 中国网络（需 ICP 备案、通过 Cloudflare 中国合作伙伴接入），或使用一层自建反代 / 优选 IP 作为补充。本工具不强制要求，按需选择。

## 13. 测试

```bash
npm test   # 聚合运行 test/ 下全部测试（test/run-all.mjs）
```

| 测试文件 | 覆盖 |
|----------|------|
| `test-model-filter.mjs` | 模型筛选纯函数 + 筛选栏渲染 |
| `test-model-table.mjs` | 模型表格 + Provider 侧栏 + F2 筛选范围 |
| `test-save-deploy.mjs` | 保存并提交三步编排 |
| `test-provider-sync-logic.mjs` | `syncProvidersToConfig` 纯函数 |
| `test-discover-progress.mjs` | 模型发现进度回调（mock fetch） |
| `test-deploy-config.mjs` | `scripts/deploy.mjs` 动态注入 KV id |
| `test-provider-routes.mjs` | Provider 路由映射（slug → pathPrefix） |
| `test-token-store.mjs` | 双凭证槽位读写 / 清除互不影响 |
| `test-providers-sync.mjs` | `mergeProviders` 合并逻辑 |
| `test-provider-view.mjs` | Provider 视图纯函数 + api update 端点 |
| `test-account-view.mjs` | Worker/账户视图纯函数 + 渲染 |
| `test-setup.mjs` | setup 纯函数 + 假 token 全流程 + CLI 接线 |
| `test-worker-config.mjs` | `getGatewayConfig` / 缺 env 友好 500 / 转发映射 |
| `test-package-meta.mjs` | npm 发布元数据（bin / files / engines 等） |
| `test-web-server.mjs` | Web 服务器基础（Hono + 静态文件 + 启动器） |
| `test-web-api-models.mjs` | 模型管理 API 端点 |
| `test-web-api-sync.mjs` | 同步 + 保存部署 API |
| `test-web-api-providers.mjs` | Provider 管理 API |
| `test-web-api-account.mjs` | Worker + 账户管理 API |
| `test-web-frontend.mjs` | 前端骨架 |
| `test-web-models-view.mjs` | 前端模型视图纯函数 |
| `test-web-providers-view.mjs` | 前端 Provider 视图纯函数 |
| `test-web-account-view.mjs` | 前端 Worker + 账户视图纯函数 |
| `test-provider-create.mjs` | Provider 创建纯函数 |
| `test-web-api-provider-create.mjs` | Provider 创建 API 端点 |
| `test-web-provider-add-view.mjs` | 前端 Provider 添加视图纯函数 |
| `test-routes-validate.mjs` | 动态路由 elements 校验纯函数 + 模板生成 |
| `test-routes-spec.mjs` | 动态路由表单 spec ↔ elements 互转（round-trip / N 级 fallback / 降级判定） |
| `test-routes-store.mjs` | data/routes.json 读写 + upsert/remove 纯函数 |
| `test-routes-deploy.mjs` | 动态路由 REST 部署编排（创建/版本/部署，全 mock） |
| `test-web-api-routes.mjs` | 动态路由配置 API 端点（保存/部署/删除/刷新，全 mock） |
| `test-gateway-config-store.mjs` | `data/gateway.json` 端口读写 / 校验 / 默认值 |
| `test-gateway-provider-keys.mjs` | 本地凭证加密存储（`AI_GW_TEST_DIR` 隔离） |
| `test-gateway-router.mjs` | slug 解析 / 剥离、厂商 URL 构造 |
| `test-gateway-backend-local.mjs` | LocalBackend 直发、流式、错误归类 |
| `test-gateway-server.mjs` | 网关端点（chat / models / health / status / shutdown / backfill） |
| `test-gateway-process.mjs` | 管理界面托管网关进程（spawn 参数 / 就绪 / 立即退出 / 关闭，全 mock） |
| `test-gateway-fallback.mjs` | 本地 fallback 链 / 重试 / percentage / 异常结构 |
| `test-gateway-web-api.mjs` | 管理服务网关 API（overview / start / stop / backfill / key） |
| `test-gateway-view.mjs` | 前端网关视图纯函数 |
| `test-worker-endpoints.mjs` | Worker 地址自动发现（workers.dev / 自定义域名 / 路由 / 容错） |

> 当前共 49 个测试文件（`test/run-all.mjs` 依次串行执行）。

## 14. 开源与仓库约定

- `data/` 目录仅白名单 `*.example.json` 模板提交到 git；真实配置（`providers.json` / `model-states.json` / `models.json`）由 setup 向导和 Web 管理界面生成，不提交。
- `ai-gateway-desk-worker` 零运行时依赖；`wrangler.toml` 不含私有值（`account_id` 移除、KV id 为占位符），配置全部 env 化，可直接分发部署。