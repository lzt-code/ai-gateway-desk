# ai-gateway-desk

AI Gateway 模型管理工具（本地 Web 界面）+ 转发封装 Worker。
以**本地 Web 网页操作为主**：用户只需在 Cloudflare dashboard 做两次手工操作（创建管理 API Token、创建 gateway 认证 token `cfut_xxx`），其余全部由 Web 管理界面通过 Cloudflare REST API 自动完成——建 gateway、存厂商 Key（BYOK）、建 Custom Provider、建 KV namespace、发现模型、生成模型列表、部署 Worker。

## 目录结构

```
ai-gateway-desk/
├── src/                      # 管理工具（Node.js ESM，本地 Web 界面）
│   ├── bin/aigd.js     # CLI 入口（web 默认 / setup / sync / deploy）
│   ├── setup.js              # 初始化向导（7 步）
│   ├── core/                 # config / state / token-store（双凭证）
│   ├── cloudflare/           # api.js（REST 封装）/ discover / providers-sync
│   ├── pipeline/             # enrich（OpenRouter 富化）/ merge（状态合并）
│   ├── output/               # generate（models.json）/ deploy（KV 部署）
│   ├── web/                  # Hono 服务器（server.js）+ 前端页面（public/）
│   └── tui/                  # 纯逻辑模块（render 渲染 / actions 状态操作 / provider-actions / account-actions）
├── ai-gateway-desk-worker/      # Cloudflare Worker（零依赖转发层）
├── data/                     # 运行时数据（私有，已被 .gitignore 排除）
├── docs/                     # 架构说明（ARCHITECTURE.md）
└── test/                     # 测试（npm test 聚合入口 test/run-all.mjs）
```

## 快速开始

```bash
npm install

# 启动本地 Web 管理界面（默认子命令，启动后自动打开浏览器）
npm run web
# 等价于：node src/bin/aigd.js web（不带子命令时默认即 web）

# 首次使用前先运行初始化向导（管理 Token → Account ID → 建 gateway → cfut_xxx → provider → KV）：
# 向导自动生成 data/providers.json；KV id 回填 kv.namespaceId，部署时动态注入。
node src/bin/aigd.js setup
```

> **关闭语义与桌面应用一致**：网页是 UI 的唯一入口，浏览器页面全部关闭后本地服务器自动退出（默认 15 秒心跳超时；页面关闭瞬间通过 `pagehide` 发送的 goodbye 信号可将退出提前到约 5 秒内）。期间刷新页面不会误退出；纯 API / 从未打开页面的场景不自动退出，按 `Ctrl+C` 手动结束。

## Web 操作

启动后浏览器自动打开 `http://localhost:<端口>`，顶部选项卡切换四个视图：

| 视图 | 功能 |
|------|------|
| Provider | 云端 Provider 列表（合并本地缓存）：编辑（slug 只读 / name 可改 / api key 仅覆盖不查看 / 云端启用 / 本地参与发现）、删除（云端 + 本地同步）、刷新 |
| 模型 | 模型表格（模型ID / Provider / 上下文 / 状态 四列）：Provider 侧栏与关键字筛选、状态切换、同步云端、保存并提交 |
| Worker | 部署状态面板（KV namespace / data/models.json / KV key），一键部署 Worker |
| 账户 | 双 token 槽位管理（管理 API Token / Gateway Token）+ gateway 信息，初始化向导入口 |

> 管理 Token 获取顺序：环境变量 `CLOUDFLARE_API_TOKEN` > 本地安全存储；缺失时 Provider 拉取降级为只读本地缓存。

各视图的交互流程与 API 接口说明见 `docs/ARCHITECTURE.md`（§4.3 Web 管理端 / §4.4 前端）。

## 凭证架构

| 凭证 | 作用域 | 用途 | 存储 |
|------|--------|------|------|
| 管理 API Token | 账户级 | 建 gateway、存 BYOK、建 KV、部署 Worker | `token-store.js` 管理槽位（`~/.ai-gateway-desk/token.management`） |
| 认证 token（`cfut_xxx`） | 绑定单个 gateway（创建时权限选 **Run**） | 模型发现 + 分发给各 PC Agent | `token-store.js` gateway 槽位（`~/.ai-gateway-desk/token`） |

> ⚠️ 管理 API Token 是账户级凭证，**绝不能分发给各 PC**；`cfut_xxx` 泄露影响面仅限其绑定的 gateway。

安全存储机制：Windows DPAPI / macOS Keychain / Linux 0600 权限文件。

## Worker 部署

`ai-gateway-desk-worker/wrangler.toml` 是**占位符模板**，不含任何私有值（`account_id` 已移除、KV id 为占位符 `<YOUR_KV_NAMESPACE_ID>`）。真实 KV namespace id 唯一存放在 `data/providers.json` 的 `kv.namespaceId`，`npm run dev` / `npm run deploy` 时由 `scripts/deploy.mjs` 动态注入生成临时配置（用完即删），**模板本身永不被修改**（git 保持干净）。

```bash
# 1. 部署上下文（二选一）：
npx wrangler login                        # 交互式登录
# 或 export CLOUDFLARE_ACCOUNT_ID=<你的账号ID>   # CI 场景

# 2. 准备 KV namespace id（二选一）：
npm run aigd setup                    # 推荐：向导第 6 步自动创建 KV 并回填 data/providers.json
# 或手动创建后填入 data/providers.json 的 kv.namespaceId：
#   npx wrangler kv:namespace create MODELS_KV

# 3. 设置 Gateway 配置（必填，secret 或 wrangler.toml [vars]）
npx wrangler secret put ACCOUNT_ID
npx wrangler secret put GATEWAY_ID

# 4. 本地开发 / 生产部署（自动注入 KV id，模板不被修改）
npm run dev
npm run deploy
```

Worker 是零依赖薄转发层，提供 OpenAI 兼容端点：

- `POST /v1/chat/completions` — 转发到 AI Gateway（`cf-aig-authorization` 头透传，移除原始 `Authorization`）
- `GET /v1/models` — 从 KV 读取模型列表

### 自定义域名绑定

**Cloudflare Dashboard 方式：**
1. **Workers & Pages** → 找到你的 Worker → **Triggers** → **Add route**
2. 输入模式：`your-domain.com/*`，Zone 选对应的域名
3. 如有旧 Worker 绑定了相同路由，先将其删除

**Wrangler CLI 方式（推荐）：**
```bash
npx wrangler routes create "your-domain.com/*" --name=<worker-name>
# 查看现有路由
npx wrangler routes list --name=<worker-name>
# 删除旧路由
npx wrangler routes delete "old-domain.com/*" --name=<worker-name>
```

---
## 测试

```bash
npm test   # 聚合运行 test/ 下全部 22 个测试文件（test/run-all.mjs）
```

| 测试文件 | 覆盖 |
|----------|------|
| `test-model-filter.mjs` | 模型筛选纯函数 + 筛选栏渲染（任务 19） |
| `test-model-table.mjs` | 模型表格 + Provider 侧栏 + F2 筛选范围（任务 24） |
| `test-save-deploy.mjs` | 保存并提交三步编排（任务 19） |
| `test-provider-sync-logic.mjs` | `syncProvidersToConfig` 纯函数（原 test-tui-provider-sync.mjs） |
| `test-discover-progress.mjs` | 模型发现进度回调（mock fetch） |
| `test-deploy-config.mjs` | `scripts/deploy.mjs` 动态注入 KV id（占位符防双 id） |
| `test-token-store.mjs` | 双凭证槽位读写 / 清除互不影响（自动备份恢复真实凭证） |
| `test-providers-sync.mjs` | `mergeProviders` 合并逻辑（任务 14） |
| `test-provider-view.mjs` | Provider 视图纯函数 + api update 端点（任务 20） |
| `test-account-view.mjs` | Worker/账户视图纯函数 + 渲染（任务 21） |
| `test-setup.mjs` | setup 纯函数 + 假 token 全流程 + CLI 接线 |
| `test-worker-config.mjs` | `getGatewayConfig` / 缺 env 友好 500 / 转发映射（mock fetch） |
| `test-package-meta.mjs` | npm 发布元数据（bin / files / engines 等） |
| `test-web-server.mjs` | Web 服务器基础（Hono + 静态文件 + 启动器，任务 25） |
| `test-web-api-models.mjs` | 模型管理 API 端点（任务 26） |
| `test-web-api-sync.mjs` | 同步 + 保存部署 API（任务 27） |
| `test-web-api-providers.mjs` | Provider 管理 API（任务 28） |
| `test-web-api-account.mjs` | Worker + 账户管理 API（任务 29） |
| `test-web-frontend.mjs` | 前端骨架（任务 30） |
| `test-web-models-view.mjs` | 前端模型视图纯函数（任务 31） |
| `test-web-providers-view.mjs` | 前端 Provider 视图纯函数（任务 32） |
| `test-web-account-view.mjs` | 前端 Worker + 账户视图纯函数（任务 33） |

## 文档

- `docs/ARCHITECTURE.md` — 架构说明（模块职责、数据模型、核心流程、关键设计决策）

## 开源说明

- `data/` 目录仅白名单 `*.example.json` 模板提交到 git；真实配置（`providers.json` / `model-states.json` / `models.json`）由 setup 向导和 Web 管理界面生成，不提交
- `ai-gateway-desk-worker` 零运行时依赖；`wrangler.toml` 不含私有值（`account_id` 移除、KV id 为占位符），配置全部 env 化，可直接分发部署
