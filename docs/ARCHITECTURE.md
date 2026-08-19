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
                                               │ wrangler kv:key put（deploy.mjs 动态注入）
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
│   ├── bin/aigd.js     # CLI 入口（web 默认 / setup / help）
│   ├── setup.js              # 初始化向导（7 步，终端交互）
│   ├── core/                 # config（providers.json 校验）/ state（model-states）/
│   │                         # token-store（双凭证安全存储）
│   ├── cloudflare/           # api.js（REST 封装）/ kv.js（管理端直读写 KV）/
│   │                         # providers-sync.js（云端列表同步）/ discover.js（模型发现）
│   ├── pipeline/             # enrich（OpenRouter 富化）/ merge（策略 A 状态合并）
│   ├── output/               # generate（models.json）/ deploy（KV 部署 + 路由映射）
│   ├── web/                  # server.js（Hono + 心跳退出）/ sync-flow.js（四步编排）/
│   │                         # public/（前端四视图，Vanilla JS）
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

子命令：`web`（默认，启动本地 Web 界面）、`setup`（终端初始化向导）。`sync` / `deploy` 为规划占位（Web 界面内已实现同功能）。

### 4.2 初始化向导 — `src/setup.js`

7 步终端引导：管理 API Token → Account ID → 建 gateway → 验证 `cfut_xxx` → 添加 Provider（BYOK 存厂商 Key / 建 Custom Provider）→ 创建 KV namespace → 生成 `data/providers.json`。

输出约定：KV namespace id 回填 `providers.json` 的 `kv.namespaceId`——**唯一数据源**，部署时由此读取。

### 4.3 Web 管理端 — `src/web/server.js`

Hono 应用，`createApp` 支持依赖注入（测试可 mock stateStore / configStore / deps）。心跳自动退出：页面存活期间前端定期上报心跳（3 分钟超时），`pagehide` 加速退出（5 秒宽限）。

| 分组 | 端点 |
|------|------|
| 健康/心跳 | `GET /api/health`、`POST /api/heartbeat` |
| 模型 | `GET /api/state`、`GET /api/models/filtered`、`POST /api/models/{toggle,remove,batch-toggle,batch-remove,edit,add}` |
| Provider | `GET /api/providers`、`/api/providers/{list,refresh,update,create,delete}` |
| 同步 | `GET /api/sync/progress`（SSE）、`POST /api/sync`、`POST /api/save`、`POST /api/save-deploy` |
| Worker | `GET /api/workers/status`、`POST /api/workers/deploy` |
| 账户 | `GET /api/account/status`、`POST /api/account/{update-token,clear-token,setup}` |

### 4.4 前端 — `src/web/public/`

Vanilla JS 单页（`app.js` / `index.html` / `style.css`），四个视图 tab：

- **Provider**：云端+本地合并列表，编辑/隐藏/删除，同步刷新
- **模型**：模型表格 + Provider 侧栏 + 关键字筛选，状态切换（selected/hidden）、编辑、手动添加、批量删除
- **Worker**：部署状态面板（KV / models.json / KV key 三态），一键部署
- **账户**：双 token 槽位管理 + gateway 信息 + 初始化向导入口

### 4.5 Cloudflare REST 封装 — `src/cloudflare/`

- `api.js`：统一 `request()`（超时 + 错误归类），按资源分组——AI Gateway（创建/查询）、BYOK provider_configs（增删改查）、Custom Providers（增删改查）、KV namespace 创建
- `kv.js`：管理端直读直写 KV 单键（读 404 返回 null 不抛错），用于跨 PC 同步 `provider-visibility`
- `providers-sync.js`：并行拉取云端 Custom Providers + BYOK 配置，与本地 `providers.json` 合并（策略 A）
- `discover.js`：模型发现，`/v1/models` 或由 pathPrefix 构造列表 URL

### 4.6 模型管道 — `src/pipeline/` + `src/output/`

- `enrich.js`：OpenRouter 富化（模块级缓存，仅新模型、仅补缺失字段，失败静默）
- `merge.js`：**策略 A：provider 永远覆盖**；仅对成功查询的 provider 执行「未发现 → removed」
- `generate.js`：过滤 selected + 隐藏 provider（`enabled===false`）的模型 → 写 `data/models.json`
- `deploy.js`：`wrangler kv:key put` 部署 models + `provider-routes` 路由映射（slug → pathPrefix）

### 4.7 数据与凭证 — `src/core/`

- `config.js`：加载并强校验 `data/providers.json`（gateway / kv / providers 逐字段断言）
- `state.js`：`model-states.json` 读写 + upsert/remove/按状态查询
- `token-store.js`：双凭证槽位（gateway `cfut_xxx` + management 管理 Token），Windows DPAPI / macOS Keychain / Linux 0600 文件，存 `~/.ai-gateway-desk/`；`AI_GW_TEST_DIR` 重定向测试隔离

### 4.8 同步编排 — `src/web/sync-flow.js`

`runSyncFlow` 纯函数：**provider 同步 → discover → merge → enrich** 四步，依赖全部注入，进度经 `onEvent` 外发（server.js 转 SSE）。容错语义：provider 同步失败不中断 discover、discover 无结果不抛错、enrich 失败静默、merge 深拷贝不改原 state。

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
{ "modelId": { "status": "selected|hidden|removed", "provider": "...", "metadata": { ... } } }
```

状态机：

```
          发现新模型
             │
             ▼
  selected ──隐藏──► hidden ──取消隐藏──► selected
     │                ▲                      │
     │  provider 不再返回                    │ provider 再次返回（复活）
     ▼                │                      │
  removed  ──删除──► 从 state 移除  ◄────────┘
```

- `selected`：写入 models.json，出现在 `/v1/models`
- `hidden`：跨更新保持隐藏，不入列表
- `removed`：provider 已下线，手动决定删除或保留

### 5.3 `data/models.json`（生成产物，gitignore）

由 generate 过滤 selected + 隐藏 provider 后输出数组，直接部署到 KV。

## 6. 凭证架构

| 凭证 | 作用域 | 用途 | 位置 |
|------|--------|------|------|
| 管理 API Token | 账户级 | 建 gateway、存 BYOK、建 KV、部署 | `token.management` 槽位 |
| 网关 token（`cfut_xxx`） | 单 gateway | 模型发现 + 分发给各 PC | `token` 槽位 |

优先级：环境变量（`CLOUDFLARE_API_TOKEN` / `GATEWAY_TOKEN`）> 本地安全存储。管理 Token 账户级凭证不可分发；`cfut_xxx` 泄露影响面仅限其绑定的 gateway。

## 7. 核心流程

### 7.1 同步（Web「一键同步」或 `POST /api/sync`）

1. provider 同步：云端的 Custom Provider / BYOK 变更合并进本地配置（无管理 Token 则跳过）
2. discover：遍历 provider 拉取模型列表
3. merge：策略 A 合并，产生新增/消失/变更摘要
4. enrich：OpenRouter 补全新模型缺失字段 → 保存 state → 生成 models.json

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
| model-states.json 唯一真相源 | 元数据首次填充后永久保留，重新发现不丢失手动编辑 |
| 策略 A（provider 永远覆盖） | provider 更新（如上下文窗口扩大）是正常现象，手动覆盖被覆盖可接受 |
| wrangler.toml 占位符 + 部署时注入 | 真实值唯一存放于 gitignore 的 providers.json，git 永远干净 |
| 纯函数 + 依赖注入（web server / sync-flow） | 全部业务逻辑可单测，测试不触网不落盘 |

## 9. 测试策略

`npm test` 聚合 `test/run-all.mjs` 下全部测试：纯逻辑单测（筛选/表格/合并/状态/凭证槽位）、API 端点测试（Hono `app.request()` 模拟 HTTP，mock fetch / fs / DB）、CLI 接线测试。测试隔离原则：`AI_GW_TEST_DIR` 重定向凭证存储、mock 依赖注入、不触真实网络与文件。