# 双网关方案（Cloud AI Gateway 与本地网关并行）

> 本文是「本地网关 + Cloudflare AI Gateway 双后端并行」的设计与实施总纲。
> 后续开发按本文「§13 分阶段实施」逐步落地，每阶段交付后回填实际情况。
> 源码为唯一真相，本文描述目标架构、模块职责、数据模型与关键数据流。
>
> 创建：2026-09-21。配套阅读：[ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 1. 背景与问题

当前调用链：

```
各 PC Agent → 云端 Worker（ai-gateway-desk-worker）→ Cloudflare AI Gateway → AI 厂商
```

Cloudflare AI Gateway 的出口 IP 在其全球边缘节点，是大量用户共享的 IP 段。部分 AI Provider 会对这类共享 IP 做风控，导致高频调用时容易收到 `429 Too Many Requests`，即使自身 Key 额度充足也会被误伤。

**核心诉求**：提供一个本地网关，让请求从用户本机出口 IP 直发厂商，绕开 Cloudflare 边缘共享 IP，降低 429 概率；同时保留 Cloudflare 路线作为可选项，二者在管理功能上完全打通，用户可无缝切换。

## 2. 目标与非目标

### 2.1 目标

1. 新增**本地网关**（`aigd gateway` 长驻进程），对外提供 OpenAI 兼容端点。
2. 本地网关与 Cloudflare AI Gateway 构成**两个并行后端**，由一个**全局模式开关**控制：
   - `local`：本机出口 IP + 本地凭证，直发厂商。
   - `cloud`：本地仅作隧道，转发到已部署的云端 Worker，走 Cloudflare AI Gateway。
3. Agent 只持有**一个稳定 Base URL**（本地固定端口），切换网关模式时 Agent 配置零改动。
4. 两种模式共用同一套 Provider、模型、动态路由配置，管理功能（同步 / 选择 / 部署 / 日志）打通。
5. 本地模式支持动态路由 fallback 链（复用 `data/routes.json`）。

### 2.2 非目标（本期不做）

1. 不集成 Portkey 等第三方完整网关（理由见 §15.2），但在架构上预留后端抽象，将来可作为可选后端接入。
2. 不做按 Provider 粒度的路由（v1 仅全局模式切换；列入阶段三）。
3. 不在 web UI 中启停 / 托管本地网关进程（v1 由独立终端命令启动；列入阶段三）。
4. 不监听局域网、不做远程多 PC 共用（本地网关仅绑定 `127.0.0.1`）。
5. 不复制 Cloudflare 的 analytics / 缓存 / 预算限流等增值能力（local 模式天然不具备）。

## 3. 整体架构

```
                         ┌──────────────────────────────────────────┐
   Agent base_url:       │  aigd gateway（长驻，127.0.0.1:8788）      │
 http://127.0.0.1:8788  ►│  OpenAI 兼容端点 + 网关管理 API            │
                         └───────────────┬────────────────┬──────────┘
                                         │                │
                    mode = local         │                │  mode = cloud
                                         ▼                ▼
                         ┌──────────────────────┐  ┌──────────────────────────┐
                         │ LocalBackend          │  │ CloudBackend             │
                         │ 本地 key（加密存储）   │  │ 转发云端 Worker           │
                         │ 本机出口 IP 直发厂商   │  │  → CF AI Gateway → 厂商   │
                         │ + 本地 fallback 引擎  │  │ （携带 cfut_xxx）         │
                         └──────────┬───────────┘  └───────────┬──────────────┘
                                    │                          │
                                    ▼                          ▼
                              AI 厂商直连                Cloudflare 边缘出口
```

两种模式下：

- `POST /v1/chat/completions`：按模式进入对应后端。
- `GET /v1/models`：**两种模式都直接读本地 `data/models.json`**，保证 Agent 看到的模型列表一致，不依赖 Cloudflare KV。

### 3.1 无缝切换的关键

1. Agent 始终只连 `http://127.0.0.1:8788`，不感知后端。
2. 模式存于 `data/gateway.json`，切换 = 修改该文件并通知运行时替换 backend，**无需重启网关进程、无需改 Agent**。
3. 模型 / Provider / 路由为两模式共享的同一份本地真相。

## 4. 两种模式的请求流

### 4.1 local 模式

```
Agent → 本地 gateway
  → 解析 body.model 中的 provider slug
  → 从本地加密存储取该 provider 的凭证 headers
  → 取 providers.json 中该 provider 的 base_url（+ pathPrefix）
  → 构造厂商真实端点，本机出口 IP 直连
  → 流式透传响应
若 model 为 dynamic/<name> → 进入本地 fallback 引擎（见 §10）
```

### 4.2 cloud 模式

```
Agent → 本地 gateway
  → 作为隧道，把请求转发到 gateway.json.cloudWorkerUrl 指向的云端 Worker
  → 携带 cfut_xxx（现有 cf-aig-authorization / Authorization 映射逻辑不变）
  → 云端 Worker → CF AI Gateway → 厂商
  → 响应透传
```

cloud 模式仍走 Cloudflare 边缘出口，429 问题依旧存在——这是用户按需选择（例如需要 analytics、或本机网络无法直连某厂商时）。

## 5. 后端抽象

定义统一后端接口，业务层只依赖接口，不依赖具体实现：

```
GatewayBackend（接口）
  chat(request, context)   # 处理 /v1/chat/completions，返回可流式的响应
  health()                 # 后端健康 / 可达性检查
```

实现：

| 后端 | 文件 | 职责 |
|------|------|------|
| `LocalBackend` | `src/gateway/backends/local.js` | slug 解析 / 剥离、取本地凭证、构造厂商 URL、超时控制、流式直传；`dynamic/*` 委托 fallback 引擎 |
| `CloudBackend` | `src/gateway/backends/cloud.js` | 把云端 Worker 的转发逻辑移植为 Node `fetch`，注入 gateway token，透传 body 与流式响应 |

模式切换 = 运行时用工厂按 `gateway.json.mode` 实例化对应 backend 并替换引用。

预留：将来可新增 `PortkeyBackend`（进程内挂载或子进程方式）实现同一接口，调用方与上层逻辑无需改动。

## 6. 目录结构（新增部分）

```
ai-gateway-desk/
├── src/
│   ├── bin/aigd.js                 # 新增 gateway 子命令分支
│   ├── gateway/                    # 【新增】本地网关
│   │   ├── server.js               # Hono app 工厂（DI 可测）+ 独立启动器（无心跳退出）
│   │   ├── config-store.js         # data/gateway.json 读写 + 模式校验
│   │   ├── router.js               # 纯函数：slug 解析/剥离、厂商 URL 构造
│   │   ├── provider-keys.js        # 厂商凭证本地加密存储（按 slug 存完整 headers）
│   │   ├── backends/
│   │   │   ├── local.js            # LocalBackend
│   │   │   └── cloud.js            # CloudBackend
│   │   └── fallback.js             # 本地动态路由 fallback 引擎（阶段二）
│   ├── cloudflare/
│   │   └── providers-sync.js       # 复用：custom headers 完整 key 回填本地
│   └── web/
│       ├── server.js               # 新增网关模式 / 凭证回填 / 状态 API
│       └── public/app.js           # Worker 视图升级为「网关」视图（阶段二）
├── data/
│   ├── gateway.json                # 【新增，gitignore】网关模式与端口配置
│   └── gateway.example.json        # 【新增，提交】模板
├── docs/
│   ├── ARCHITECTURE.md             # 补充本地链路与新模块
│   └── DUAL-GATEWAY-PLAN.md        # 本文
└── test/
    ├── run-all.mjs                 # 注册新增测试
    └── test-gateway-*.mjs          # 【新增】网关相关测试
```

## 7. 网关服务器 — `src/gateway/server.js`

- Hono 应用工厂 `createGatewayApp(deps)`，依赖注入（configStore / keyStore / backendFactory / fetch 等），对齐 `web/server.js` 的可测模式。
- 独立启动器 `startGateway({ port, mode })`，使用 `@hono/node-server`，**仅绑定 `127.0.0.1`**，无心跳自动退出机制（与 web 管理服务器刻意区分）。
- CORS：与现有 Worker 一致，动态回显预检所需头。

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 进入当前 backend |
| `/v1/models` | GET | 读本地 `data/models.json`，包装为 `{ object:'list', data }` |
| `/health` | GET | 网关进程存活 + 当前模式 + backend 健康 |
| `/api/gateway/mode` | GET / POST | 读取 / 切换全局模式（写 gateway.json 并热替换 backend） |
| `/api/gateway/status` | GET | 模式、端口、cloudWorkerUrl、各 provider 本地凭证状态 |
| `/api/gateway/backfill-keys` | POST | 从云端拉 custom-provider 完整 key 回填本地（见 §8.2） |

端口冲突（EADDRINUSE）需返回友好提示，告知端口被占用或已有一个网关在跑。

## 8. 凭证策略

### 8.1 凭证存储 — `src/gateway/provider-keys.js`

- 复用 `src/core/token-store.js` 的系统级加密原语：Windows DPAPI / macOS Keychain / Linux 0600 文件。
- 在 `~/.ai-gateway-desk/` 下按 provider slug 存**完整 headers 对象**（不止 Bearer，兼容自定义鉴权头），如 `provider-keys/<slug>`。
- 测试通过 `AI_GW_TEST_DIR` 重定向隔离，与现有 token-store 一致。
- token-store 可抽出通用「按 key 名读写加密串」能力，但须保留现有 `readToken/writeToken` 等导出不破坏。

### 8.2 是否需要重填 Key（结论）

**不需要全部重填，按 Provider 类型区分：**

| 类型 | 云端是否可读回完整 key | 本地模式处理 |
|------|------------------------|--------------|
| custom-provider | **可以**。管理 API `listCustomProviders` 返回的 `headers` 为完整未脱敏字符串（展示层才做 `maskApiKey`） | 首启 / 手动触发**自动回填**，用户无感 |
| byok | **不可以**。仅返回 `secret_preview` 掩码，无法还原 | 必须在 UI **重新录入一次** |

自动回填的前置条件：

1. 本地存有**管理 API Token**（账户级，setup 第 1 步那个）。无管理 Token 时无法拉取，UI 降级为提示手工录入。
2. 回填流程：`fetchCloudProviders` → 取 custom-provider 的 `headers` → 解析 → 写入 provider-keys 本地加密存储。

### 8.3 录入即双写（今后）

新增 Provider 或覆盖 Key 时（`web/server.js` 的 create / update、`setup.js` 向导），在现有「写云端」之外**同步写一份到本地加密存储**：

- create 端点：云端创建成功后写本地 key。
- update 覆盖 key：云端更新成功后覆盖本地 key。
- delete：云端删除后同步删除本地 key。

双写后即不再依赖云端回填；两处写入应尽量保证一致性，本地写失败需明确告警但不阻断云端结果。

## 9. 数据模型

### 9.1 `data/gateway.json`（新增，gitignore）

```json
{
  "mode": "local",
  "port": 8788,
  "cloudWorkerUrl": "https://ai-gateway-desk-worker.<你的Workers子域>.workers.dev"
}
```

| 字段 | 校验 | 说明 |
|------|------|------|
| `mode` | `'local' \| 'cloud'` | 全局后端选择，默认 `local` |
| `port` | 正整数，1–65535 | 本地网关固定端口，默认 8788 |
| `cloudWorkerUrl` | http(s) URL | cloud 模式的云端 Worker 地址，可由现有部署状态推导回填 |

`data/gateway.example.json` 提供占位模板并提交（对齐现有白名单约定）。

### 9.2 现有数据文件（两模式共享，不改结构）

| 文件 | 角色 |
|------|------|
| `data/providers.json` | gateway / kv / providers（含 base_url、pathPrefix）配置 |
| `data/model-states.json` | 模型状态唯一真相源（selected/pending/hidden） |
| `data/models.json` | 生成产物，两模式 `/v1/models` 的共同来源 |
| `data/routes.json` | 动态路由本地真相源，cloud 部署 CF、local 本地执行 |

## 10. 本地动态路由 fallback 引擎 — `src/gateway/fallback.js`（阶段二）

`data/routes.json` 的 elements 图直接可用（线性链示例见 `data/routes.example.json`）。

执行语义（与 Cloudflare 对齐）：

1. 从 `start` 出发，进入首个 `model` 节点。
2. 每个 `model` 节点按自身 `properties.timeout` / `retries` 调用对应 provider 的**本地直发**。
3. 可重试错误（网络失败 / 429 / 5xx）在重试耗尽后走 `fallback` 边到下一个节点。
4. 收到 200 响应头即判定成功并开始向客户端返回；4xx（非 429）立即报错，不回退。
5. `percentage` 节点可顺带实现随机权重分支。
6. 超出本地能力的图结构（`conditional` / `rate` / 组合节点等）返回明确错误：「本地模式不支持该图结构，请改用 cloud 模式」。

已知限制（须文档注明）：

- **流式开始后无法回退**：上游一旦返回 200，错误可能出现在 SSE 流中途，此时不能再切换后续节点（Cloudflare 同理）。

## 11. 功能打通清单

| 功能 | 打通方式 |
|------|----------|
| Provider 管理 | 同一套 `providers.json`；新增 / 编辑 / 删除在现有云端逻辑上增加本地 key 双写 |
| 模型选择 | 同一套 `model-states.json`；勾选 / 隐藏 / 编辑结果对两模式同时生效 |
| 模型列表 | 两模式 `/v1/models` 统一读本地 `data/models.json` |
| 动态路由 | `routes.json` 一份配置两处生效：cloud 部署到 CF，local 本地引擎执行 |
| 保存即部署 | 现有 save-deploy 扩展为**双端同步**：写云端 KV / 路由 + 更新本地配置（阶段二） |
| 日志 | 本地网关请求汇入现有 io-logger；cloud 模式另提供 CF analytics / logs 外链 |
| 凭证 | 录入即双写 + custom-provider 自动回填；BYOK 提示重录 |

## 12. CLI 与 Web UI

### 12.1 CLI — `src/bin/aigd.js`

新增子命令：

```bash
aigd gateway [--port 8788] [--mode local|cloud]
```

- 默认读 `data/gateway.json`，命令行参数可覆盖。
- 长驻进程，打印监听地址与当前模式，Ctrl+C 退出。
- 支持 `AIGD_GATEWAY_PORT` 环境变量。
- 更新 HELP 文本与子命令分支（与现有 `web` / `setup` 并列）。

与 web 管理服务器刻意分离：web 用随机端口 + 心跳退出，不适合承载需要稳定地址的网关。

### 12.2 Web UI（阶段二）

将现有 **Worker 视图升级为「网关」视图**：

- 两张状态卡片：云端 Worker、本地网关（监听地址、当前模式、运行状态）。
- 全局模式开关（写 `gateway.json`，若网关在跑则热切换）。
- 各 provider 本地凭证状态列表 + 「从云端回填 Key」按钮；BYOK 项标记「需重新录入」。
- 统一 Base URL 一键复制（`http://127.0.0.1:8788/v1`）。
- v1 不在 UI 中启停网关进程，仅展示与配置。

## 13. 分阶段实施

### 阶段一：可用的双后端

> ✅ 已完成（2026-09-21）：8 项任务全部落地。`npm test` 44/44 通过，
> 新增 6 个测试文件（config-store / provider-keys / router /
> backend-local / backend-cloud / server，共 114 条断言）；
> 已通过真实进程冒烟（/health、/v1/models、模式热切换、端口占用提示）。

1. ✅ `data/gateway.json` + example 模板 + `config-store.js`（读写与校验）。
2. ✅ `provider-keys.js`：本地加密存储（复用 token-store 原语，测试隔离）。
3. ✅ `router.js`：slug 解析 / 剥离、厂商 URL 构造（base_url + pathPrefix）纯函数。
4. ✅ `backends/local.js`、`backends/cloud.js`：两后端直发 / 转发，流式透传。
5. ✅ `gateway/server.js`：Hono app + 启动器，统一 chat 与 models 端点，模式热切换。
6. ✅ 录入 provider key 处增加本地双写（create / update / delete、setup）。
7. ✅ CLI `aigd gateway` 子命令。
8. ✅ 测试：router / provider-keys / 两 backend / API 端点，注册 `run-all.mjs`。

交付标准：Agent 改 base_url 为本地端口即可用；local / cloud 可切换；custom-provider 凭证可回填。

> 实际回填与方案差异：
> 1. 额外新增 `src/gateway/provider-lookup.js`（gateway slug →
>    providers.json 条目查找），§6 目录树未列出。
> 2. BYOK 本地直发：`router.js` 内置 10 个常见 byok slug 的 OpenAI
>    兼容 base_url 映射（openai / openrouter / anthropic / google /
>    groq / deepseek / xai / mistral / together / perplexity），条目自带
>    base_url 时优先；未覆盖且缺失则报错。
> 3. cloudWorkerUrl 手动填写，缺失时 cloud 请求返回 400。
> 4. local 模式遇 `dynamic/*` 返回 501（fallback 引擎阶段二）。
> 5. 上游超时 120s，网络错误 / 超时统一归类 502。

### 阶段二：路由打通与管理界面

> ✅ 已完成（2026-09-21）：5 项任务全部落地。`npm test` 47/47 通过，
> 新增 3 个测试文件（fallback / web-api / view，共 100 条断言），
> 已通过真实进程冒烟（/health、status 凭证列表、网关视图 API）。

1. ✅ `fallback.js`：本地 fallback 引擎（线性链 + percentage；异常结构明确报错）。
2. ✅ 「网关」视图：双卡片、模式开关、凭证状态、回填按钮、Base URL 复制。
3. ✅ save-deploy 双端同步：现有三步编排已同时落本地真相（model-states /
   models.json）与云端 KV；动态路由 routes.json 一份两处生效。
4. ✅ 测试：fallback 引擎 + 网关视图 API + 前端视图纯函数。
5. ✅ 文档：README 增加「本地网关与双模式」章节，ARCHITECTURE.md 补 §4.12 与数据模型。

> 实际回填与方案差异：
> 1. 管理服务新增独立总览端点 `/api/gateway/overview`（§7 端点表列在网关
>    进程侧，实际由 web 管理服务聚合 gateway.json + 进程探测 + 凭证状态），
>    并新增 `POST /api/gateway/{cloud-url,provider-key}` 两个端点。
> 2. 网关未运行时：模式切换直接写 gateway.json（下次启动生效）；回填在
>    管理进程内直接拉云端 headers 写本地加密存储。
> 3. BYOK 手工录入以 `Authorization: Bearer <key>` 形式写本地（自定义鉴权
>    头的 BYOK 暂不支持手工录入，可走 custom-provider）。
> 4. 阶段一 501 占位已移除，`dynamic/*` 进入 fallback 引擎。
> 5. 旧测试 token-store / setup 的真实凭证目录快照函数已兼容新增的
>    `provider-keys/` 子目录（EISDIR 修复）。

### 阶段三：可选增强

1. 按 provider 粒度路由（部分走本地、部分走云端）。
2. web UI 中启停 / 托管网关进程（子进程看护、崩溃重启）。
3. 网关开机自启 / 后台常驻。
4. 视需要以子进程或进程内方式接入 Portkey 作为可选后端。

## 14. 测试策略

延续现有约定：纯函数 + 依赖注入，不触真实网络与凭证。

| 新增测试文件（建议） | 覆盖 |
|----------------------|------|
| `test-gateway-router.mjs` | slug 解析 / 剥离、URL 构造（含 / 不含 pathPrefix） |
| `test-gateway-provider-keys.mjs` | 按 slug 读写 / 覆盖 / 删除 headers；`AI_GW_TEST_DIR` 隔离 |
| `test-gateway-config-store.mjs` | gateway.json 读写、模式 / 端口校验、默认值 |
| `test-gateway-backend-local.mjs` | LocalBackend 直发（mock fetch、流式、错误归类） |
| `test-gateway-backend-cloud.mjs` | CloudBackend 转发 Worker（URL、token 注入、透传） |
| `test-gateway-server.mjs` | API 端点（chat / models / mode / status / backfill，全 mock） |
| `test-gateway-fallback.mjs` | 阶段二：fallback 链触发、重试、成功短路、不支持结构报错 |

全部注册进 `test/run-all.mjs`，`npm test` 聚合运行；`prepublishOnly` 已绑定测试。

## 15. 风险与决策记录

### 15.1 风险

| 风险 | 说明 | 应对 |
|------|------|------|
| 厂商 base_url 约定不一 | 部分 base_url 已含 `/v1`，尾部路径拼接可能重复或缺失 | router 统一归一化；启用 provider 时做一次连通性校验 |
| 本机网络无法直连 | 原靠 CF 边缘访问的厂商（如部分地区访问 OpenAI），local 模式反而不通 | 属预期；UI 根据可达性给出模式建议，可切回 cloud |
| Key 落本地的攻击面 | 本地网关需持有真实厂商 Key | 复用系统级加密（DPAPI / Keychain），仅当前用户可解密 |
| 流式中途失败 | 200 后 SSE 内报错无法回退 | 文档注明，与 Cloudflare 行为一致 |
| cloud 模式不解决 429 | cloud 仍走边缘共享 IP | 明确两种模式定位，由用户按需选择 |
| 双写一致性 | 云端成功但本地写失败（或反之） | 本地失败显式告警，提供回填 / 重试，不静默 |

### 15.2 为什么不直接集成 Portkey（决策）

1. npm 包 `@portkey-ai/gateway` 仅暴露 `bin`，未导出可 import 的 app 入口；源码虽 `export default app`，但源码集成需引入 TypeScript 工具链或维护 fork。
2. 仍带来 14 个依赖（ioredis、avsc、smithy、ws 等）与 `patch-package` 后处理，与项目克制的依赖风格冲突。
3. 现有 provider 实际均为 OpenAI 兼容 custom-provider，Portkey 的 250+ 协议转换、guardrails 等能力大部分用不上。
4. model 命名（`slug/model`）、provider 识别、`routes.json`→Portkey config 仍需写翻译层。

**结论**：核心诉求是换出口 IP，自建薄层（移植现有 Worker chat.js 逻辑）即可满足；同时用 `GatewayBackend` 接口预留，将来需要多协议 / 复杂编排时再以可选后端接入 Portkey，不影响调用方。

## 16. 默认约定

| 项 | 约定 |
|----|------|
| 本地网关监听 | `127.0.0.1`（不对外暴露，不做鉴权） |
| 默认端口 | `8788`（避开 wrangler / Portkey 默认的 8787） |
| 默认模式 | `local` |
| Agent 配置 | Base URL `http://127.0.0.1:8788/v1`，可携带任意 Authorization（local 忽略，cloud 透传） |
| 模型列表 | 两模式统一读本地 `data/models.json` |
| 凭证目录 | `~/.ai-gateway-desk/provider-keys/<slug>`（系统级加密） |
