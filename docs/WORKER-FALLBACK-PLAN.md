# Worker 侧动态路由 fallback 引擎（方案 A）

> 本文是「把动态路由 fallback 从 Cloudflare 搬到 Worker 边缘执行」的设计总纲。
> 源码为唯一真相，本文描述动因、架构、数据模型、行为语义与落地步骤。
> 配套阅读：[ARCHITECTURE.md](ARCHITECTURE.md)（§4.10 Worker、§4.12 本地网关）。
>
> 创建：2026-09-28。状态：**设计待实现**。

---

## 1. 背景与问题

### 1.1 现状

云端调用链：

```
Agent → Worker（ai-gateway-desk-worker）→ Cloudflare AI Gateway → AI 厂商
```

当 `body.model` 形如 `dynamic/<name>` 时，Worker **不解析**（`routes/chat.js` 的
provider slug 解析不命中 `provider-routes`），原样透传到 CF 网关的
`/v1/{account}/{gateway}/compat/chat/completions`；**fallback 链由 Cloudflare
AI Gateway 的动态路由（Dynamic Routes）执行**。

本地调用链另有自研引擎 `src/gateway/fallback.js`，用 `base_url + pathPrefix`
本机直发厂商，**本身已能跑火山方舟等非标准路径**——但仅对 `127.0.0.1:8788` 生效。

### 1.2 问题

CF 动态路由经 Unified API 对 custom provider **固定请求
`{base_url}/v1/chat/completions`**，无法携带自定义路径前缀，fallback 到
火山方舟这类非标准路径的 provider 必然 404。

该限制已记录在源码中（`src/pipeline/routes-validate.js:29-32`，2026-09-09 实测）：

> provider 配置了非标准路径（pathPrefix，如火山方舟 `/api/plan/v3`）时，
> 动态路由无法携带该路径前缀 → 该级必然 404。

### 1.3 破局点

**同一条 CF 网关，直连时支持非标准路径**。`routes/chat.js` 已实现 provider-specific
端点（`provider-routes` KV 就是为此而生）：

```
https://{host}/v1/{account}/{gateway}/{slug}{pathPrefix}/chat/completions
// 例：.../custom-fang-zhou/api/plan/v3/chat/completions  ✅ 可达火山方舟
```

结论：**CF 网关的转发能力支持 pathPrefix，只有「动态路由」这个编排层不支持。**
那就不要把编排交给 CF——把编排搬到 Worker 边缘。

### 1.4 方案选型

| 方案 | 说明 | 取舍 |
|------|------|------|
| **A（本文）** | Worker 内置 fallback 引擎，边缘执行链 | 云端路线彻底支持非标准路径；Worker 从纯翻译层升级为编排层 |
| B | 只用本地引擎（`aigd gateway`） | 零改动，但仅本机生效、需本地密钥 |
| C | 混合：仅含 pathPrefix 的路由 Worker 接管 | 保留其余路由的 CF 侧 analytics，逻辑最复杂 |
| D | 把路径内联进 custom provider 的 `base_url` | 赌 CF 拼接规则（固定追加 `/v1/chat/completions`），**不采用** |

本文落地 **方案 A**；§11 保留把开关退化为方案 C 的空间。

---

## 2. 方案总览

### 2.1 新数据流

```
Agent ──► Worker POST /chat/completions
              │
              ├─ model 非 dynamic/*  → 现状不变（compat / provider-specific 直连）
              │
              └─ model = dynamic/<name>
                    └─► WorkerFallbackEngine.execute(name, body)
                          │  KV: dynamic-routes  → 取该路由 elements
                          │  KV: provider-routes → 取各 provider pathPrefix
                          ├─ start → 首个 model 节点
                          ├─ 每个 model 节点：
                          │    有 pathPrefix → /{slug}{pathPrefix}/chat/completions（剥离 slug）
                          │    无 pathPrefix → /compat/chat/completions（保留 slug/model）
                          │    按节点 retries / timeout 重试
                          │    429 / 5xx / 网络失败 → 走 fallback 边
                          │    其余 4xx → 立即返回（不回退）
                          └─ 200 → 流式透传响应
```

### 2.2 分布式状态（不破坏无状态）

「无状态」指 **Worker isolate 不持有跨请求的内存 / 持久状态，任一 isolate 可服务任一请求**。
本方案全部运行时状态在外部：

| 状态 | 位置 |
|------|------|
| 路由链 elements | KV（新键 `dynamic-routes`），每请求读 |
| provider pathPrefix | KV（现有键 `provider-routes`），每请求读 |
| 厂商密钥 / 鉴权 | CF AI Gateway（Worker 只透传 `cf-aig-authorization`） |
| 请求内 visited / attempts / 重试计数 | 请求处理函数局部变量，请求结束即释放 |

补充：**现状已经在每请求读 KV**（`routes/chat.js:98` 读 `provider-routes`），
本方案不引入新的状态类别。Worker 仍不落盘、不缓存密钥。

**唯一性质变化**：Worker 从「纯 header 翻译层」升级为「带编排逻辑的控制层」。
这是产品取向的取舍，不是无状态问题。§9 列出对「薄」的补偿措施（默认关闭开关、
KV 缺失回退、仅 `dynamic/` 介入）。

---

## 3. 数据模型

### 3.1 新增 KV 键 `dynamic-routes`

由管理端在部署 / 删除 / 刷新动态路由时写入（见 §5）。结构：

```json
{
  "glm-5-2": {
    "elements": [
      { "id": "START", "type": "start", "outputs": { "next": { "elementId": "model-level-1" } } },
      {
        "id": "model-level-1",
        "type": "model",
        "properties": { "provider": "custom-mo-da", "model": "ZhipuAI/GLM-5.2", "timeout": 60000, "retries": 2 },
        "outputs": { "success": { "elementId": "END" }, "fallback": { "elementId": "model-level-2" } }
      },
      { "id": "END", "type": "end", "outputs": {} }
    ]
  }
}
```

- 键名 = 路由名（与 `routes.json` 的 `routes[name]` 一致，也是 Agent 填的 `dynamic/<name>`）。
- 值只保留引擎执行所需的 `elements`（不写 `dirty` / `cloudId` / `deployedVersion`
  等本地/云同步元数据）。
- 元素格式与 CF 原生 1:1（沿用 `data/routes.json` 的 elements），Worker 直接执行，
  无转换层。

### 3.2 复用现有键

| 键 | 用途 | 现状 |
|----|------|------|
| `provider-routes` | `{ "<gatewaySlug>": "<pathPrefix>" }` | 已由 `src/output/deploy.js` 写入，Worker 门面 URL 判定复用 |
| `models` | 精选模型列表（含 `dynamic/<name>` 条目） | 已写入，Agent 侧选模型的来源 |

### 3.3 与 `data/routes.json` 的关系

`data/routes.json` 仍是**唯一真相源**（本地编辑 + CF 云端部署）。
新增的 KV 键是**派生视图**，在部署节点同步，不反向写回。二者关系：

```
data/routes.json ──(REST)──► CF 动态路由（保留：可见性 / 后台管理）
                 └─(KV)────► dynamic-routes ──► Worker 引擎执行（新增）
```

---

## 4. Worker 引擎设计

新增模块 `ai-gateway-desk-worker/src/routes/fallback.js`，语义对齐
`src/gateway/fallback.js`（本地引擎）与 CF 平台行为。

### 4.1 触发条件

`handleChat` 中，`extractProviderSlug(body.model) === 'dynamic'` 时进入引擎；
`routeName = model.slice('dynamic/'.length)`。其余路径逐字节维持现状。

### 4.2 执行语义

1. 从 `start` 节点沿 `outputs.next` 进入首个节点。
2. `model` 节点：按自身 `properties.timeout` / `properties.retries` 转发；
   `retries` 缺省 0，`timeout` 缺省 120000ms（`AbortController`）。
3. **可重试 / 可回退**：网络失败、429、5xx。重试（`retries + 1` 次）耗尽后走
   `outputs.fallback` 边。
4. **终止**：其余 4xx 立即返回该响应，不回退。
5. **成功**：收到 200 即判定成功，开始向客户端流式返回（`response.body` 透传，
   不缓冲）。
6. `percentage` 节点：按输出端口权重（`"10%"` 形式）随机选一支，语义同本地引擎
   `pickPercentageOutput`。
7. `conditional` / `rate`：暂返回明确错误（「该结构仅 Cloudflare 支持」），
   与本地引擎保持一致；后续可单独扩展（§12）。
8. 环检测：访问过的节点 id 集合，重复即报错（对齐本地引擎）。
9. 走到 `END` 或 `fallback` 边缺失 → 502「所有候选均失败」+ 各节点失败摘要。

### 4.3 节点 URL 与 body 构造

| 节点 `properties.provider` | `provider-routes` 命中 | 目标 URL | 转发 `body.model` |
|-----------------------------|------------------------|----------|-------------------|
| `custom-agnes`（无 pathPrefix） | 否 | `https://{host}/v1/{acc}/{gw}/compat/chat/completions` | `custom-agnes/<properties.model>`（保留 slug） |
| `custom-fang-zhou`（pathPrefix=`/api/plan/v3`） | 是 | `https://{host}/v1/{acc}/{gw}/custom-fang-zhou/api/plan/v3/chat/completions` | `<properties.model>`（剥离 slug） |

- 其余请求字段（messages / stream / temperature …）原样透传，仅覆写 `model`。
- 头处理与现状一致：`Authorization` → `cf-aig-authorization`，删除 `Authorization`，
  `Content-Type: application/json`，`Accept: text/event-stream`。

### 4.4 状态判定

| 上游结果 | 处理 |
|----------|------|
| 200 | 成功，流式透传 |
| 429 / 5xx | 重试，耗尽后走 fallback |
| 网络异常 / 超时（AbortError） | 重试，耗尽后走 fallback |
| 其余 4xx | 终止返回，不回退 |
| provider 未配置 pathPrefix 但节点有 `custom-` 前缀 | 正常（走 compat） |

### 4.5 向后兼容与灰度

- KV 无 `dynamic-routes` 键、或路由名不存在 → **回退现状**（透传到 CF compat 端点，
  由 CF 动态路由执行）。保证旧部署与未同步路由零影响。
- 新增 `env.WORKER_FALLBACK` 开关（`auto` | `on` | `off`，默认 `auto`）：
  - `auto`：KV 命中则引擎执行，否则 CF 动态路由；
  - `on`：强制引擎（KV 缺失即报错，便于排查）；
  - `off`：始终现状透传（等价关闭本方案，退回方案 C 的能力边界）。

---

## 5. 管理端改动

### 5.1 新增 `buildDynamicRoutesJson`

位置 `src/output/routes-deploy.js`（与 `deployRouteConfig` 同层）。
纯函数：由 `routesState.routes` 生成 `dynamic-routes` 的 JSON 字符串，
只取 `elements`，跳过无 elements 的条目。

### 5.2 新增 `deployDynamicRoutesToKV`

参考 `src/output/deploy.js` 的 `deployProviderRoutesToKV` 模式，
经 `src/cloudflare/kv.js` 的 `writeKvValue` 写 REST，走 `src/core/io-logger.js`
统一日志：

- 无 `kv.namespaceId` → `skipped`，不报错；
- 与 `provider-routes` 一样，失败**不阻断** CF 动态路由部署结果，显式透出告警。

### 5.3 触发点（同步调用）

| 端点 / 流程 | 时机 |
|-------------|------|
| `POST /api/routes/deploy`（`src/web/server.js:2385`） | 部署成功后，按最新 routes 全量重推 `dynamic-routes` |
| `POST /api/routes/delete` | 本地删除成功后重推（摘除该路由） |
| `POST /api/routes/refresh` | 云端覆盖本地成功后重推（与服务端模型列表同步一致） |
| 首次部署 / 模型列表同步 | 复用现有 `syncModelsToKv` 附近的同步时机 |

### 5.4 校验告警调整

`src/pipeline/routes-validate.js` 与 `src/web/server.js` 的
`customPathProviderSlugs` / pathPrefix 警告：引擎接管后该级**不再必然 404**，
文案从「建议改用其他 provider」降级为提示，并在前端路由视图说明
「由 Worker 引擎执行 / 由 CF 动态路由执行」。

---

## 6. 文件清单

```
ai-gateway-desk-worker/
└── src/
    ├── routes/
    │   ├── chat.js          # 修改：dynamic/* 分派到 fallback 引擎（含开关与回退）
    │   └── fallback.js      # 新增：Worker 侧 fallback 引擎
    └── config.js            # （可选）读取 WORKER_FALLBACK 开关

src/
├── output/
│   ├── routes-deploy.js     # 新增 buildDynamicRoutesJson / deployDynamicRoutesToKV
│   └── deploy.js            # 复用 writeKvValue / 日志模式
├── web/server.js            # 部署/删除/刷新成功后同步 dynamic-routes
└── pipeline/routes-validate.js  # pathPrefix 警告文案调整
```

---

## 7. 日志约定

遵循 `AGENTS.md`，全部 IO 走统一日志器：

- Worker 侧：`ai-gateway-desk-worker/src/io-log.js`，
  操作名 `worker:chat:dynamic/<name>`、子事件 meta 带 `node` / `provider` / `model`；
  默认输出 `logResult`（成功/失败 + elapsedMs + 摘要），debug 输出
  `logRequest` / `logResponse`（脱敏 `cf-aig-authorization` / 厂商头）。
- 管理端：`src/core/io-logger.js`，操作名 `routes:kv:dynamic-routes`
  （写入结果 + elapsedMs），与 `deploy:kv:models` / `routes:deploy` 风格一致。

---

## 8. 行为对齐矩阵

| 能力 | CF 动态路由 | 本地引擎 | **Worker 引擎（本方案）** |
|------|-------------|----------|---------------------------|
| 标准 v1 端点 fallback | ✅ | ✅ | ✅ |
| 非标准路径（pathPrefix，如火山方舟） | ❌ 必 404 | ✅ | ✅（复用 provider-specific 端点） |
| 跨 PC 可用（无需本地进程） | ✅ | ❌ | ✅ |
| 密钥不出 CF | ✅ | ❌（本地加密存储） | ✅ |
| `percentage` 权重 | ✅ | ✅ | ✅ |
| `retries` / `timeout` | ✅ | ✅ | ✅ |
| `conditional` / `rate` | ✅ | ❌ 明确报错 | ❌ 明确报错（可后续扩展） |
| 路由级 analytics（CF 后台） | ✅ | ❌ | ⚠️ 仅provider 级（每次尝试仍经 CF 网关） |
| 流式中途失败回退 | ❌ | ❌ | ❌（与两者一致） |

---

## 9. 「薄」的补偿措施

方案 A 唯一的性质变化是 Worker 变「厚」。落地时以如下约束补偿：

1. `dynamic-routes` 缺失即回退现状（默认不改行为）。
2. 仅当 `model` 以 `dynamic/` 开头才进入引擎，其余路径零改动。
3. `WORKER_FALLBACK=off` 可一键退回纯转发。
4. 引擎为纯函数 + 注入依赖（`fetchFn` / KV 读取器），无额外运行时依赖，
   保持零依赖 Worker。
5. 不引入 isolate 内存缓存（避免最终一致性陷阱），KV 直读。

---

## 10. 风险与缓解

| 风险 | 说明 | 缓解 |
|------|------|------|
| KV 最终一致性 | 新路由边缘可见可能延迟 ~60s | 与现有 `provider-routes` 表现一致；UI 提示「部署后稍候生效」 |
| 单请求多次 fetch | 长链 + 重试使墙钟变长 | 限制链长 / 总尝试上限；`timeout` 逐节点生效 |
| Workers 时长限制 | 长链可能触及平台墙钟上限 | 节点级 timeout 收敛 + 文档说明，超出时返回明确错误 |
| body 改写错误 | provider-specific 需剥离 slug，compat 保留 | 单元测试覆盖两种分支 + 真机验证方舟 |
| 错误响应缺 CORS | 引擎自建 JSON 错误需补头 | 复用 `http.js` 的 `CORS_HEADERS` / `jsonResponse` |
| 路由 analytics 弱化 | 无 CF 路由级统计 | 保留 CF 动态路由部署（可见性），如需统计可退回 `off` |

---

## 11. 测试计划

延续「纯函数 + 依赖注入，不触真实网络与凭证」：

| 测试 | 覆盖 |
|------|------|
| `test-worker-fallback.mjs`（新增） | 链执行、重试耗尽、429/5xx 回退、4xx 终止、`percentage`、环检测、`conditional`/`rate` 报错 |
| worker URL 构造 | pathPrefix 命中 → provider-specific + 剥离 slug；未命中 → compat + 保留 slug |
| KV 缺失回退 | 无 `dynamic-routes` → 透传现状 / `WORKER_FALLBACK=on` 时报错 |
| `test-routes-deploy.mjs`（扩展） | `buildDynamicRoutesJson` 输出（只取 elements、跳过空条目） |
| `test-deploy-config.mjs`（扩展） | `deployDynamicRoutesToKV` 写入键名 / skipped / 失败告警 |
| 回归 | 现有 `test-provider-routes.mjs`、`test-gateway-fallback.mjs` 全绿 |

---

## 12. 实施步骤

1. **管理端 KV 同步**（可独立上线，零行为影响）：
   `buildDynamicRoutesJson` + `deployDynamicRoutesToKV` + 三处触发点 + 测试。
2. **Worker 引擎**：新增 `routes/fallback.js`，`chat.js` 接入分派与开关，
   默认 `auto`（KV 命中才启用）+ worker 测试。
3. **告警 / 文案**：`routes-validate.js` warning 降级，前端路由视图标注执行方。
4. **文档**：更新 `ARCHITECTURE.md`（Worker 职责、新 KV 键）、`README.md`
   的「动态路由」章节。
5. **灰度**：先 `auto` 观察，稳定后将火山方舟类路由纳入链；必要时 `off` 回退。

---

## 13. 非目标

1. 不对接 / 复制 CF 的路由级 analytics、缓存、预算限流。
2. 不在本方案内实现 `conditional` / `rate`（保留明确报错，后续单独立项）。
3. 不改本地引擎与其语义（两边保持算法对齐即可）。
4. 不废除 CF 动态路由部署（保留可见性与后台管理入口）。