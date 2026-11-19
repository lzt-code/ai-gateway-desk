# 变异测试记录（2026-11-19）

> 对 `src/pipeline` + `src/core` 的一次手动变异测试（mutation testing），目标是回答：
> **这些测试真的能拦住回归吗？** 本文只记录事实与待办，不作为质量结论。

## 一、运行信息

| 项 | 内容 |
|---|---|
| 基线 | `origin/main` @ `1846c7f`（`main` 分支，工作区干净，无 diff） |
| 范围 | `src/pipeline/{merge,routes-validate,enrich}.js`、`src/core/{net-retry,providers-config,config,routes-store,state,token-store,io-logger}.js` |
| 未纳入 | enrich 的 fetch/超时/日志路径；token-store 的 Windows DPAPI / macOS Keychain 分支；io-logger 的纯格式化拼接 |
| 环境 | Node.js 23；测试为原生 `.mjs` 断言脚本（无测试框架）；Stryker 不可用 → **手动循环（路径 B）** |
| 方法 | 一次只注入一个变异 → `node --check` → 跑相关测试 → 立即还原 → SHA256 校验 |
| 变异数 | 74（0 invalid；1 个首次行号定位错误，修正后补跑计入） |
| 结果 | **67 被杀 / 7 存活 = 90.5%** |
| 严重项 | 12，已全部修复并复验杀死 |
| 修复后基线 | `npm test` → 55/55 通过 |
| 清理校验 | 10 个源码文件 SHA256 与开始时一致；仅测试文件改动；未提交、未推送、未改 CI |

复跑方式（本轮变异定义脚本在临时目录，未入库）：

```bash
# 单个变异：只改一处 → 语法检查 → 跑相关测试 → 立即还原并核对哈希
node --check src/pipeline/enrich.js
node test/test-enrich-models-dev.mjs
```

## 二、发现的问题

### 2.1 严重项（12 个，均已修复）

| # | 位置 | 变异 | 风险 |
|---|---|---|---|
| 1 | `src/core/io-logger.js:39` | 短 token（≤8）直接返回明文 | 日志/SSE 泄露凭证 |
| 2 | `src/core/io-logger.js:40` | `maskToken` 整体返回原文 | 同上 |
| 3 | `src/core/io-logger.js:46` | Authorization 头不打码 | 同上 |
| 4 | `src/core/io-logger.js:76` | body 中 `secret/token/apiKey` 不打码 | 同上 |
| 5 | `src/core/token-store.js:181` | 删除名称 null 字节校验 | 凭证名可绕过约束 |
| 6 | `src/core/token-store.js:186` | 删除路径穿越防护 | `../` 可读写 `STORE_DIR` 之外文件 |
| 7 | `src/core/token-store.js:202` | `secretExists` 恒真 | 未保存凭证被误判为存在 |
| 8 | `src/pipeline/enrich.js:310` | OR 价格 `>=0` → `>0` | **钱**：免费模型价格 0 被丢弃 |
| 9 | `src/pipeline/enrich.js:324` | MD 成本 `>=0` → `>0` | **钱**：同上（models.dev 源） |
| 10 | `src/pipeline/enrich.js:436` | `if (freshPricing)` 取反 | **钱**：上游改价不跟随 |
| 11 | `src/core/state.js:57` | 删除 `entry.manual = true` | 手工模型下次同步被自动删除（数据丢失） |
| 12 | `src/pipeline/routes-validate.js:128` | 删除 `model.outputs.success` 校验 | 非法图通过本地校验，部署被 Cloudflare 7001 拒绝 |

### 2.2 无效测试例（6 个用例）

定义：用例存在、断言直接相关，但对应业务代码被改坏后仍通过。

| # | 测试文件 | 用例 | 对应变异 | 未拦住的原因 |
|---|---|---|---|---|
| 1 | `test/test-routes-validate.mjs` | 「rate 非法 limitType/limit/window/缺 key → 不通过」 | `routes-validate.js:146`、`:149` | 四种错误绑在一张图，`limitType` 先报错；`window:-1` 也不是边界值 |
| 2 | `test/test-net-retry.mjs` | 「onRetry 回调收到尝试序号与等待时长」 | `net-retry.js:79` | `baseDelayMs=1`，第一次 wait=1 与常量相同；只断言第一次 |
| 3 | `test/test-web-api-models.mjs` | 「测试 18: add — 新模型」 | `state.js:57` | 只断言 status/provider/state 键，没断言 `manual` |
| 4 | `test/test-onboarding.mjs` | 「回填 kv.namespaceId 保留 key」 | `providers-config.js:124` | 输入 `kv.key` 已存在，从未走 `\|\| DEFAULT` 分支 |
| 5 | `test/test-routes-store.mjs` | 「缺 routes 键 → 空骨架」 | `routes-store.js:41` | 只有缺键/损坏 JSON，没有 `routes:null` |
| 6 | `test/test-enrich-models-dev.mjs` | 「场景1 OR 匹配」 | `enrich.js:52` | 低优先级末段匹配兜底，`shortIdOf` 坏了仍能匹配 |

处理结果：

- 第 1–5 个用例已直接补强，复验对应变异全部被杀。
- 第 6 个用例本身仍不具备单独敏感性；已新增「场景20 短 id 优先级」在套件层面覆盖该变异。

### 2.3 缺测（27 个变异点，无对应用例）

| 位置 | 变异 | 现状 |
|---|---|---|
| `merge.js:76` | diffMetadata 不过滤易变字段 | 已补 |
| `merge.js:114` | status 变更判定取反 | 已补 |
| `merge.js:121` | 空 changes 未过滤 | 已补 |
| `merge.js:185` | `created` 被上游覆盖 | 已补 |
| `routes-validate.js:101` | 空 elementId 校验删除 | 已补 |
| `routes-validate.js:128` | 缺 `outputs.success` | 已补 |
| `routes-validate.js:181` | 权重和容差放宽到 1 | 已补 |
| `enrich.js:261` | OR name 模糊 `\|\|`→`&&` | 已补 |
| `enrich.js:310` | OR 价格 `>=0` → `>0` | 已补 |
| `enrich.js:324` | MD 成本 `>=0` → `>0` | 已补 |
| `enrich.js:384` | 空 modalities 数组仍写入 | 已补 |
| `enrich.js:670` | 别名条件 `&&`→`\|\|` | 已补 |
| `net-retry.js:82` | onRetry detail 丢失 | 已补 |
| `providers-config.js:51` | 顶层数组不拒绝 | 已补 |
| `state.js:55` | `metadata.id` 不强制取 `modelId` | 已补 |
| `token-store.js:181` | null 字节校验删除 | 已补 |
| `token-store.js:186` | 路径穿越防护删除 | 已补 |
| `token-store.js:202` | `secretExists` 恒真 | 已补 |
| `token-store.js:258` | 缓存失效判定取反 | 已补 |
| `io-logger.js:39` | 短 token 明文 | 已补 |
| `io-logger.js:40` | 长 token 明文 | 已补 |
| `io-logger.js:46` | Authorization 不打码 | 已补 |
| `io-logger.js:76` | body secret 不打码 | 已补 |
| `config.js:30` | 配置缺失校验取反 | **未补**（遗留） |
| `config.js:61` | `kv.key` 可选分支取反 | **未补**（遗留） |
| `config.js:76` | providers 循环 off-by-one | **未补**（遗留） |
| `config.js:143` | 判空 `\|\|`→`&&` | **未补**（遗留） |

> 注：`config.js:143` 变异后仍会失败，只是错误文案变化；仍按「缺测」记录。

### 2.4 等效 / 不可判定（3 个，非缺口）

| 位置 | 变异 | 判定 | 依据 |
|---|---|---|---|
| `token-store.js:268` | 缓存空值 | 等效 | `mtime=0` 时缓存 `null`，与重新读取结果一致 |
| `io-logger.js:100` | 删除环形缓冲上限 | 等效 | 仅影响内存与可回溯长度，不影响返回内容 |
| `state.js:87` | `getByStatus` 过滤取反 | 不可判定 | `src/` 内无调用方；死代码还是预留导出需业务决定 |

## 三、本次修改（仅测试文件）

| 文件 | 补的断言 |
|---|---|
| `test/run-all.mjs` | 注册 `test-io-logger.mjs` |
| `test/test-io-logger.mjs`（新增） | 短/长 token 打码、Authorization 头、JSON body 递归脱敏、环形缓冲 |
| `test/test-merge.mjs` | `created` 不被覆盖；`buildSyncDetails` 忽略易变字段、过滤空 changes、status 变更明细 |
| `test/test-routes-validate.mjs` | `outputs.success` 缺失、空 elementId 文案、`limit=0`、`window=0`、权重和 99.5 |
| `test/test-enrich-models-dev.mjs` | 免费价格 0（OR/MD）、OR 单侧模糊名、空 modalities、短 id 优先级、别名不覆盖正名 |
| `test/test-net-retry.mjs` | 退避 10/20 递增、`onRetry.detail` 含根因 |
| `test/test-onboarding.mjs` | 顶层数组视为空对象；`kv` 无 key 回填 `models` |
| `test/test-routes-store.mjs` | `{"routes":null}` → 空骨架 |
| `test/test-token-store.mjs` | null 字节报错文案、`../` 写入/读取抛错、`secretExists` 未保存=false、外部改写后缓存失效、子路径读写删 |
| `test/test-web-api-models.mjs` | 手工新增 `entry.manual === true`；`metadata.id` 强制等于 `modelId` |

复验：修复涉及的 30 个变异点逐个重新注入，**30/30 全部被杀**。

## 四、遗留问题

| 优先级 | 位置 | 问题 | 建议动作 |
|---|---|---|---|
| P1 | `src/core/config.js:30,61,76,143` | `loadConfig()` 零测试；路径硬编码 `data/providers.json`，测试无法重定向 | 先给 `loadConfig(deps = {})` 增加 `configPath` 注入（与 `providers-config.js`、`setDebugFlag` 风格一致），再用临时目录补测；改生产代码需单开任务 |
| P2 | `src/core/state.js:87` | `getByStatus/getSelected` 在 `src/` 内无调用方 | 确认是死代码则删除；否则补单测并在调用点接线 |
| P3 | `test/test-enrich-models-dev.mjs` 场景1 | 用例本身仍无法单独发现 `shortIdOf` 被改坏（已由场景20 在套件层面兜住） | 如需「用例自证」，改为断言命中来源；会改变原用例意图，按需处理 |
| — | `src/core/token-store.js:268`、`src/core/io-logger.js:100` | 等效变异 | 无需处理 |
| — | 平台分支 | Windows DPAPI / macOS Keychain 分支本轮未突变（无法在 Linux 测试模式覆盖） | 后续可在对应平台补一次定向验证 |

## 五、备注

- 本轮所有改动均在测试文件内，业务代码零修改（SHA256 逐一核对）。
- 测试改动尚未提交，当前工作区包含：9 个测试文件修改 + 1 个新增 `test/test-io-logger.mjs`。
- 变异定义脚本存放于临时目录（`%TEMP%/opencode/`），未入库；如需长期复跑，建议引入 Stryker 或把变异清单固化为脚本。
- 严重项占比与得分仅描述本轮样本：**74 个变异中 67 个被杀、7 个存活（其中 4 个为 `config.js` 缺测、2 个等效、1 个不可判定）**。
