# 系统托盘方案：本地网关运行状态可视化

> 目标：用户关闭 WebUI 管理界面后，仍能通过系统托盘图标直观看到本地网关的运行状态，并能完成启动 / 停止 / 打开管理界面等常用操作。
> 状态：方案设计（2026-10-03）。
>
> **路线调整（2026-10-03）**：v1 已改用更轻量的「控制台窗口」方案并落地——WebUI 启动网关时在可见终端窗口中运行（窗口在 = 网关在，日志实时可见），跨平台实现见 `src/gateway/console-window.js`。窗口生命周期与网关退出码绑定：正常退出（UI「关闭网关」/ 窗口内 Ctrl+C，code 0）自动关窗，异常退出（启动失败 / 崩溃，code != 0）保留窗口供查看错误输出。本托盘方案保留为 v2 可选增强，解决"窗口最小化后无环境状态"的场景。

## 1. 背景与问题

当前两个长驻相关的进程：

| 进程 | 启动方式 | 生命周期 |
|------|----------|----------|
| Web 管理服务器 | `aigd web` | 浏览器页面全部关闭后心跳超时自动退出（桌面应用式关闭语义） |
| 本地网关 | `aigd gateway` | 无心跳退出，长驻，直到 Ctrl+C 或 `POST /api/gateway/shutdown` |

问题：WebUI 关闭后，网关进程仍在后台运行，但用户没有任何可视化途径确认它是否活着。用户只能开任务管理器找 node 进程，或重新打开 WebUI 间接确认，体验差。

## 2. 设计目标与非目标

**目标**

1. 托盘图标三态直观表达网关状态：未运行（灰）/ 运行中（绿）/ 异常（红）。
2. 不打开 WebUI 即可完成：查看状态、启动网关、停止网关、打开管理界面。
3. 跨平台（Windows / macOS / Linux），平台能力缺失时优雅降级，不影响网关本身。
4. 不破坏现有原则：网关仅绑 127.0.0.1、IO 走统一日志器、Worker 保持零依赖。

**非目标**

- 不在托盘内重做管理功能（模型管理、部署等仍归 WebUI）。
- 不引入 Electron 等重型框架。
- v1 不做请求量统计图表（状态接口扩展预留，见 §8）。

## 3. 技术选型

### 3.1 托盘库

| 候选 | 原理 | 维护状态 | 结论 |
|------|------|----------|------|
| `systray`（zaaack/node-systray） | Node 通过 stdin/stdout JSON 驱动自带的 Go 预编译二进制 | 已停更 | 不选 |
| **`systray2`**（felixhao28 fork） | 同上，API 兼容并修复 bug、支持子菜单 | npm 最新 2.1.4（2022 停更但功能稳定） | **选用** |
| `node-systray-v2`（Edgar-P-yan） | 同上，活跃一些 | 未发布 npm，需从 GitHub 安装 | 备选 |
| Electron Tray | 框架自带 | 活跃 | 体积 100MB+，否决 |

选 `systray2` 的理由：npm 直装、无需 node-gyp 编译（自带 win/darwin/linux 预编译二进制）、API 面小（约 10 个方法），即使彻底停更也可以低成本 vendor 或替换，锁定风险低。

风险与缓解：

- **停更风险**：托盘交互面很小，抽象一层 `src/tray/tray-driver.js` 隔离 systray2 API，未来替换只动这一个文件。
- **包体积**：三个平台二进制共约 10–15MB 进 node_modules，npm 发布包随依赖安装，可接受。
- **Linux 桌面碎片化**：GNOME 3 默认无托盘，需 AppIndicator 扩展；库启动失败时降级（见 §9）。

### 3.2 进程模型：独立托盘监控进程

新增 `aigd tray` 子命令，托盘是**独立 Node 进程**，与网关进程解耦：

```
┌─────────────────────────────────────────────┐
│ aigd tray（托盘监控进程，常驻）                │
│  ├─ systray2 二进制（图标 + 菜单）            │
│  ├─ status-poller：每 5s GET /health         │
│  │     127.0.0.1:<port>                      │
│  └─ gateway-manager：spawn/stop 网关子进程    │
└──────────────┬──────────────────────────────┘
               │ HTTP（仅 127.0.0.1）
        ┌──────▼──────┐         ┌──────────────┐
        │ aigd gateway │         │ aigd web     │
        │ /health      │         │ （按需启动，  │
        │ /api/gateway/│         │  心跳退出）   │
        │  status      │         └──────────────┘
        └─────────────┘
```

为什么不把托盘嵌进 `aigd gateway` 进程：

| 维度 | 独立 tray 进程（选） | 嵌在 gateway 进程内 |
|------|---------------------|---------------------|
| 网关未运行时 | 灰图标仍在，明确告诉用户"没在跑" | 无图标，用户无法区分"没装"和"没启动" |
| 托盘崩溃 | 不影响网关转发 | 可能拖垮网关 |
| 网关崩溃 | 托盘立刻变红/灰并提示 | 一起死，无人报告 |
| 进程数 | +1 个轻量 Node 进程（约 40MB 内存） | 少一个进程 |

代价是多一个常驻进程，换来状态可见性的本质提升，值得。

## 4. 状态机与轮询策略

### 4.1 三态模型

| 状态 | 判定条件 | 图标 | tooltip 示例 |
|------|----------|------|--------------|
| `stopped` 未运行 | 端口连接被拒（ECONNREFUSED）连续 2 次 | 灰色 | `AI Gateway · 未运行` |
| `running` 运行中 | `GET /health` 返回 200 且 `ok:true` | 绿色 | `AI Gateway · 运行中 · :8788` |
| `error` 异常 | 端口有响应但非 200 / 响应 `ok:false` / 连续 3 次超时 | 红色 | `AI Gateway · 异常（详见菜单）` |

区分 ECONNREFUSED 与其他错误是关键：前者是"没启动"，后者是"端口被别的程序占用"或"网关内部故障"，两者用户动作不同。

### 4.2 轮询参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 间隔 | 5000ms | 本机请求成本极低，5s 足够灵敏 |
| 单次超时 | 2000ms | 本机健康检查不应超过 2s |
| 进入 stopped | 连续 2 次 ECONNREFUSED | 避免网关重启瞬间图标闪跳 |
| 进入 error | 连续 3 次超时，或 1 次明确的错误响应 | 明确故障立刻报，抖动多给机会 |
| 日志 | 状态**变化**时 `logResult('tray:poll', ...)`，不变不记 | 遵守统一日志规范，避免每 5s 刷一条无意义日志 |

端口来源：与 CLI 一致的优先级 `--port` 参数 > `AIGD_GATEWAY_PORT` > `data/gateway.json` > 默认 8788。

## 5. 托盘菜单设计

```
┌─────────────────────────────┐
│ ● 运行中 · 端口 8788         │  ← disabled 状态行，动态更新
│   3 个 provider · 运行 2 小时 │  ← disabled 副状态行（来自 /api/gateway/status）
├─────────────────────────────┤
│ 打开管理界面                 │  → spawn aigd web（detached）
│ 复制 Base URL                │  → http://127.0.0.1:8788/v1 入剪贴板
├─────────────────────────────┤
│ 停止网关                     │  ← running 时可用 / stopped 时显示"启动网关"
│ 重启网关                     │  ← running 时可用
├─────────────────────────────┤
│ 打开数据目录                 │  → 系统文件管理器打开 data/
│ 开机自启                ✓    │  ← checked 项（见 §7，可放 v2）
├─────────────────────────────┤
│ 退出托盘                     │  只退托盘，不动网关
└─────────────────────────────┘
```

行为细节：

- **启动网关**：`spawn(process.execPath, [aigdPath, 'gateway'], { detached: true, stdio: 'ignore' })`，随后轮询自然变绿。不重复启动：已 running 时菜单项禁用。
- **停止网关**：优先 `POST /api/gateway/shutdown`（该端点已拒绝浏览器 Origin，托盘进程不带 Origin，天然兼容）；若 3s 无响应且确认是本托盘 spawn 的子进程，兜底 `child.kill()`。
- **异常状态点击**：菜单首行显示具体错误（如"端口 8788 被其他程序占用"）。
- **退出托盘**：`systray.kill()` + `process.exit(0)`，明确不动网关进程，避免误杀正在服务的转发。

## 6. 模块结构

```
src/tray/
├── index.js            # aigd tray 入口：组装 driver + poller + manager + menu
├── tray-driver.js      # systray2 唯一接触点：初始化 / 更新图标 / 更新菜单 / 事件桥接
├── status-poller.js    # 轮询 /health + /api/gateway/status，输出三态（fetch 可注入，纯逻辑可测）
├── menu-model.js       # 纯函数：(state, statusData) → systray2 菜单 JSON（可测）
├── gateway-manager.js  # spawn / shutdown / 端口检测 / 单实例锁
└── clipboard.js        # 平台剪贴板（win: clip / mac: pbcopy / linux: xclip，可选项）

assets/tray/
├── icon-running.ico / .png      # 绿
├── icon-stopped.ico / .png      # 灰
├── icon-error.ico   / .png      # 红
└── iconTemplate.png             # macOS 菜单栏 template image（黑白，自动适配深色）
```

约束：

- 托盘所有 IO（轮询、shutdown 请求、spawn）走 `src/core/io-logger.js` 的 `logResult`，操作名 `tray:poll` / `tray:gateway:start` / `tray:gateway:stop` 风格。
- `status-poller.js` 与 `menu-model.js` 不 import systray2，保持纯逻辑，对齐 `src/tui/` 的可测模式。
- 单实例锁：`data/tray.pid` 记录托盘进程 pid，启动时 `process.kill(pid, 0)` 探测存活，已存活则提示并退出，防止多个托盘图标。

## 7. 跨平台差异与自启动

| 事项 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 图标格式 | `.ico`（16/24/32/48 多分辨率合一） | `.png` template image | `.png` |
| 托盘位置 | 右下角通知区域 | 顶部菜单栏右侧 | 依桌面环境 |
| 前置条件 | 无 | 无 | libappindicator3 / libayatana-appindicator3；GNOME 需 AppIndicator 扩展 |
| 开机自启（v2） | 注册表 `HKCU\...\Run` 写 `aigd-tray` | `~/Library/LaunchAgents/` plist | `~/.config/autostart/` .desktop |

开机自启列为 v2：v1 用户手动 `aigd tray` 启动即可，验证稳定后再加菜单勾选项。

## 8. 状态数据源

复用现有端点，v1 **无需改动 gateway**：

- `GET /health` → 存活判定（三态状态机输入）
- `GET /api/gateway/status` → 菜单副状态行（provider 数、凭证状态）
- `POST /api/gateway/shutdown` → 停止网关

可选增强（v2，小改动）：`/api/gateway/status` 增加 `startedAt`（计算运行时长）与请求计数（成功/失败），让 tooltip 能显示"运行 2 小时 · 128 次请求"。需在 gateway 进程内维护计数器，改动集中在 `server.js`，不进 v1 范围。

## 9. 降级与错误处理

| 场景 | 行为 |
|------|------|
| systray2 二进制启动失败（Linux 缺 appindicator 等） | 捕获后打印明确警告（含 Linux 依赖安装提示），退出码 0，绝不影响已运行的网关 |
| 端口被非网关程序占用 | 状态 `error`，菜单显示"端口 8788 被其他程序占用"，禁用启动/停止 |
| 网关进程崩溃 | 轮询探测到后图标转灰，菜单提示"网关已退出" |
| `aigd tray` 重复启动 | pid 锁探测到已有实例，提示后退出 |
| 托盘进程被强杀 | 网关不受影响（进程解耦的核心收益） |

## 10. 测试策略

对齐现有 `test/run-all.mjs` 聚合模式，新增 `test/tray-*.mjs`：

| 测试对象 | 方式 |
|----------|------|
| `menu-model.js` | 纯函数单测：三态 × 各状态数据 → 菜单 JSON 快照断言 |
| `status-poller.js` | 注入 mock fetch：ECONNREFUSED / 200 ok / 500 / 超时 → 状态迁移断言（含连续次数阈值） |
| 集成 | 用 `createGatewayApp` 起随机端口的真实 app，poller 指向它验证 running 判定 |
| 手测清单 | Windows 三态图标切换、菜单动作、关 WebUI 后托盘仍在、杀网关后图标变灰 |

systray2 二进制本身不进自动化测试（GUI 依赖），由 `tray-driver.js` 薄层隔离，手测覆盖。

## 11. 依赖与发布变更

- `package.json` dependencies 增加 `systray2`；`files` 增加 `assets`。
- `aigd.js` HELP 增加 `aigd tray` 子命令说明。
- README 增加托盘章节（图标截图 + 各平台前置条件）。

## 12. 实施步骤

| 里程碑 | 内容 | 产出 |
|--------|------|------|
| M1 | `status-poller.js` + `menu-model.js` 纯逻辑 + 单测 | 状态机与菜单模型就绪 |
| M2 | `tray-driver.js` + `index.js` + `aigd tray` 子命令 | 三态图标可见、轮询驱动切换 |
| M3 | `gateway-manager.js`：启动/停止/重启 + pid 锁 | 菜单完整可用 |
| M4 | 图标资源制作（三态 × ico/png）+ Windows 实测 | 视觉达标 |
| M5（v2） | 开机自启、复制 Base URL、status 接口扩展 | 体验完善 |

M1–M4 为 v1 范围，预估每个里程碑均可独立交付、独立测试。
