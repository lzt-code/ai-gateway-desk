# ai-gateway-desk

用**本地 Web 界面**管理 Cloudflare AI Gateway：建 gateway、存厂商 Key（BYOK）、发现模型、生成模型列表，并一键部署零依赖转发 Worker。你只需要在 Cloudflare Dashboard 做两次手工操作（创建管理 API Token、创建 gateway 认证 token `cfut_xxx`），其余全部由 Web 界面通过 Cloudflare REST API 自动完成。

> 想了解架构与实现细节？见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 安装

```bash
npm install -g ai-gateway-desk
```

安装后可用 `aigd` 命令；也可在仓库目录 `npm install` 后使用 `npm run web`。

## 前置条件

使用本工具前，需先在 Cloudflare 完成两步准备（Web 界面无法代你完成）：

1. 创建**管理 API Token**（账户级）——用于建 gateway、存 BYOK、建 KV、部署 Worker。
2. 创建 gateway 认证 token `cfut_xxx`（权限选 **Run**）——用于模型发现与分发给各 PC Agent。

## 快速开始

```bash
# 1. 启动本地 Web 管理界面（默认子命令，启动后自动打开浏览器）
aigd web

# 2. 首次使用运行初始化向导，按顺序完成 7 步引导：
#    管理 Token → Account ID → 建 gateway → 验证 cfut_xxx
#    → 添加 Provider（BYOK / Custom Provider）→ 创建 KV → 生成配置
aigd setup
```

> 向导会自动创建 KV namespace 并把 id 回填到本地配置，后续部署无需手动填 KV id。

## 管理界面

浏览器打开 `http://localhost:<端口>` 后，顶部四个视图：

- **Provider**：管理云端 Provider（编辑 / 隐藏 / 删除 / 同步刷新）
- **模型**：模型表格，按 Provider 或关键字筛选，切换状态（selected / hidden）、编辑、添加、批量删除
- **Worker**：查看部署状态，一键部署转发 Worker
- **账户**：管理双 token 槽位与 gateway 信息，重新进入初始化向导

> 关闭语义与桌面应用一致：浏览器页面全部关闭后本地服务器自动退出；刷新页面不会误退出。

### 调试日志（详细日志开关）

页面底部日志栏右侧的「调试日志」开关（持久化在 `data/providers.json` 顶层 `debug` 字段，下次同步生效）。开启后同步模型时，每个 Provider 调用 `/models` 的完整请求与响应都会被记录：

- **服务器终端**：完整输出——请求头（`cf-aig-authorization` 的 token 已脱敏）、响应状态/响应头、响应体全文；失败请求（如 400 / 非法 JSON）同样输出。
- **Web 日志栏**：逐条输出请求行 + 脱敏请求头 + 响应状态/响应头 + 响应体预览（前 1000 字符，超长提示看终端），并同步输出到进度日志。

关闭时保持原有简洁日志（请求 URL + 成功/失败摘要）。

## 部署转发 Worker

Web 界面的 **Worker** 视图提供一键部署；如需命令行部署或绑定自己的域名，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 「§12 部署转发 Worker」与「§12.1 访问地址与自定义域名绑定」。

部署前需设置 Gateway 配置（任选其一）：

```bash
npx wrangler secret put ACCOUNT_ID
npx wrangler secret put GATEWAY_ID
```

部署完成后，Worker 默认挂在 Cloudflare 分配的 `*.workers.dev` 子域下，访问地址为：

    https://ai-gateway-desk-worker.<你的Workers子域>.workers.dev

- `<你的Workers子域>` 在 Cloudflare Dashboard → **Workers & Pages** → 右上角「你的子域」查看（账户级，仅首次设置，形如 `my-account`）。
- 各 PC Agent 的 OpenAI `base_url` 填上面的完整地址，端点：
  - `POST /v1/chat/completions` — 转发到 AI Gateway
  - `GET /v1/models` — 返回已选模型列表

各 PC Agent 只需统一 Base URL + 携带 `cfut_xxx` 即可调用。

> ⚠️ `*.workers.dev` 默认域名在部分网络环境下可能被 DNS 污染 / 不可达（例如中国大陆）。若 Agent 部署在上述区域或访问不稳定，建议绑定自己的域名，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 「§12.1 访问地址与自定义域名绑定」。

## 常用命令

| 命令 | 说明 |
|------|------|
| `aigd web` | 启动本地 Web 管理界面（默认） |
| `aigd setup` | 运行终端初始化向导 |
| `aigd --help` | 查看帮助 |

## 许可证

[MIT](LICENSE)
