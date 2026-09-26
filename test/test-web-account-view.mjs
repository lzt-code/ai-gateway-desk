/**
 * 任务 33 验证脚本：前端 Worker + 账户视图纯函数
 *
 * 覆盖（交付包 §5.1 的 11 个用例）：
 *  - buildWorkersStatusView：全配置 / 未配置 KV / kvKey error / models 缺失
 *  - buildAccountStatusView：三态 source / env+hasLocal 提示 / gateway 未配置 / 槽位说明文案
 *  - slotLabel：management/gateway 映射 + 非法值透传
 *  - 导出存在性：3 个新函数 + 任务 30-32 导出回归
 *
 * 无 DOM 环境，视图交互（部署状态机 / 弹窗 / flash / 刷新按钮）由浏览器手工验收（交付包 §6）。
 */

const mod = await import('../src/web/public/app.js')
const {
  buildWorkersStatusView,
  buildAccountStatusView,
  buildManagementTokenInfo,
  slotLabel,
  api,
  registerViewRenderer,
  buildModelTableRows,
  buildProviderTableRows,
} = mod

let failures = 0
let checks = 0

function check(cond, msg) {
  checks++
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

// ── fixtures（交付包 §4.1/§4.3 样例）──────────────────────
const statusAll = {
  ok: true,
  namespaceId: '2a3b4c5d6e7f8g9h0i1j2k3l',
  modelsJsonExists: true,
  modelCount: 12,
  kvKeyExists: true,
  canDeploy: true,
  kvNamespace: { configured: true, id: '2a3b4c5d6e7f8g9h0i1j2k3l' },
  modelsJson: { exists: true, count: 12 },
  kvKey: { status: 'exists', detail: '存在' },
}
const statusNoKv = {
  ok: true,
  namespaceId: '',
  modelsJsonExists: false,
  modelCount: null,
  kvKeyExists: false,
  canDeploy: false,
  kvNamespace: { configured: false, id: '' },
  modelsJson: { exists: false, count: null },
  kvKey: { status: 'skipped', detail: '未检查（未配置 KV）' },
}
const gatewayReady = { accountId: 'abc123', gatewayId: 'cf-ai-gateway' }
const gatewayNone = { accountId: '未配置', gatewayId: '未配置' }

// ── 1-4：buildWorkersStatusView ───────────────────────────
section('buildWorkersStatusView')

// 1：全配置（KV 已配置 + models 存在 + kvKey exists + canDeploy true）
const w1 = buildWorkersStatusView(statusAll)
check(w1.includes('已配置') && w1.includes('2a3b…2k3l'), '全配置 → 含「已配置 (2a3b…2k3l)」（前4…后4 截断）')
check(w1.includes('title="2a3b4c5d6e7f8g9h0i1j2k3l"'), '全配置 → namespaceId 完整值放 title 属性')
check(w1.includes('存在（12 个模型）'), '全配置 → 含「存在（12 个模型）」')
check(w1.includes('>存在<'), '全配置 → KV key 显示「存在」')
check(w1.includes('可部署 ✓'), '全配置 → 含「可部署 ✓」')
check(w1.includes('v ok'), '全配置 → 状态为 ok 色')

// 2：未配置 KV（namespaceId 空 + kvKey skipped + canDeploy false）
const w2 = buildWorkersStatusView(statusNoKv)
check(w2.includes('未配置'), '未配置 → KV namespace 显示「未配置」')
check(w2.includes('不存在'), '未配置 → models.json 显示「不存在」')
check(w2.includes('未检查'), '未配置 → KV key 显示「未检查」')
check(w2.includes('不可部署'), '未配置 → 含「不可部署」')
check(w2.includes('v warn'), '未配置 → 状态为 warn 色')

// 3：kvKey error
const w3 = buildWorkersStatusView({ ...statusAll, kvKey: { status: 'error', detail: '无法读取' } })
check(w3.includes('无法读取'), 'kvKey error → 含「无法读取」（warn）')

// 4：models 缺失
const w4 = buildWorkersStatusView({ ...statusAll, modelsJson: { exists: false, count: null } })
check(w4.includes('不存在'), 'models 缺失 → 含「不存在」')

// ── 5-8：buildAccountStatusView ───────────────────────────
section('buildAccountStatusView')

// 5：三态 source（local / env / none）
const a1 = buildAccountStatusView(
  {
    management: { source: 'local', hasLocal: true, label: '本地已存', mark: '●' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
  },
  gatewayReady,
)
check(a1.includes('● 本地已存'), 'management local → 「● 本地已存」')
check(a1.includes('○ 未配置'), 'gateway none → 「○ 未配置」')
const a1Env = buildAccountStatusView(
  {
    management: { source: 'env', hasLocal: false, label: 'env 提供', mark: '●' },
    gateway: { source: 'local', hasLocal: true, label: '本地已存', mark: '●' },
  },
  gatewayReady,
)
check(a1Env.includes('● env 提供'), 'management env → 「● env 提供」')

// 6：env + hasLocal 提示
const a2 = buildAccountStatusView(
  {
    management: { source: 'env', hasLocal: true, label: 'env 提供', mark: '●' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
  },
  gatewayReady,
)
check(a2.includes('env 提供') && a2.includes('本地已存'), 'env + hasLocal → 含「env 提供」和「本地已存」提示')

// 7：gateway 未配置（warn 类 + 初始化提示）
const a3 = buildAccountStatusView(
  {
    management: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
  },
  gatewayNone,
)
check(a3.includes('未配置') && a3.includes('v warn'), 'gateway 未配置 → warn 色「未配置」')
check(a3.includes('尚未初始化'), 'gateway 未配置 → 含「尚未初始化，点击下方『初始化向导』」')

// 8：槽位说明文案
check(a1.includes('绝不分发'), 'management 卡含「绝不分发」说明文案')
check(a1.includes('cfut_xxx'), 'gateway 卡含「cfut_xxx」说明文案')

// 8b：管理 API Token 卡 Cloudflare 外链（添加 / 编辑入口，仅 management 卡出现一次）
check(a1.includes('dash.cloudflare.com/profile/api-tokens'), 'management 卡含 Cloudflare API Tokens 外链')
check(
  a1.includes('href="https://dash.cloudflare.com/profile/api-tokens"') &&
    a1.includes('target="_blank"') &&
    a1.includes('rel="noopener noreferrer"'),
  '外链为新窗口打开且带 rel=noopener noreferrer',
)
check(a1.split('dash.cloudflare.com/profile/api-tokens').length - 1 === 1, '外链仅在 management 卡出现一次')

// 8c：令牌自检区块（名称 + 所需权限表格）经第 3/4 参数注入 management 卡
const manifestFixture = [
  { id: 'ai-gateway-edit', label: 'AI Gateway · Edit', reason: '创建网关 / 存厂商 Key / 管理动态路由', required: true },
  { id: 'workers-kv-edit', label: 'Workers KV Storage · Edit', reason: '创建 KV namespace', required: true },
  { id: 'zone-read', label: 'Zone · Read', reason: '列出可用 Zone（可选）', required: false },
]
const permsFixture = [
  { ...manifestFixture[0], granted: true },
  { ...manifestFixture[1], granted: false },
  { ...manifestFixture[2], granted: false },
]
const a1Info = buildAccountStatusView(
  {
    management: { source: 'local', hasLocal: true, label: '本地已存', mark: '●' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
  },
  gatewayReady,
  { ok: true, configured: true, name: 'My Token', status: 'active', permissions: permsFixture, permissionsReadable: true },
  manifestFixture,
)
check(a1Info.includes('My Token'), 'management 已配置 → 卡内渲染令牌名称')
check(a1Info.includes('token-perms-table'), 'management 已配置 → 卡内渲染权限表格')
const a3Info = buildAccountStatusView(
  {
    management: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
  },
  gatewayNone,
  { ok: true, configured: false },
  manifestFixture,
)
check(a3Info.includes('尚未配置管理 Token'), 'management 未配置 → 提示按表创建令牌')
check(a3Info.includes('token-perms-table'), 'management 未配置 → 仍展示所需权限表格')
check(!a3Info.includes('Token 名称'), 'management 未配置 → 不显示令牌名称行')

// ── 8d：buildManagementTokenInfo ──────────────────────────
section('buildManagementTokenInfo')
// tokenInfo 未返回但有静态清单 → 先渲染表格（状态未获取），不依赖 Cloudflare 调用成功
const tiLoading = buildManagementTokenInfo(undefined, manifestFixture)
check(tiLoading.includes('token-perms-table'), '未获取 tokenInfo → 仍渲染所需权限表格')
check(tiLoading.includes('— 未获取') && tiLoading.includes('检查中'), '未获取 → 状态「未获取」+ 检查中提示')
check(
  buildManagementTokenInfo(undefined, undefined).includes('正在获取所需权限清单'),
  '清单与 tokenInfo 均缺 → 获取清单占位',
)
const tiNotConfigured = buildManagementTokenInfo({ configured: false }, manifestFixture)
check(
  tiNotConfigured.includes('尚未配置管理 Token') && tiNotConfigured.includes('token-perms-table'),
  '未配置 → 提示 + 仍展示所需权限表格',
)
check(!tiNotConfigured.includes('Token 名称'), '未配置 → 不显示令牌名称行')
// ok:false：仍展示表格 + 失败提示（用户仍知道需要哪些权限）
const tiErr = buildManagementTokenInfo(
  {
    ok: false,
    configured: true,
    error: '401: invalid token',
    permissions: manifestFixture.map((p) => ({ ...p, granted: null })),
    permissionsReadable: false,
  },
  manifestFixture,
)
check(tiErr.includes('令牌检查失败') && tiErr.includes('401'), 'ok:false → 失败提示含 error')
check(tiErr.includes('token-perms-table'), 'ok:false → 表格仍在（用户仍知道需要什么权限）')
// 正常：名称 + 状态 + 表格状态回填
const ti = buildManagementTokenInfo(
  { ok: true, configured: true, name: 'My Token', status: 'active', permissions: permsFixture, permissionsReadable: true },
  manifestFixture,
)
check(ti.includes('My Token'), '显示令牌名称')
check(ti.includes('active'), '显示令牌状态')
check(ti.includes('✓ 已具备'), '已授予 → ✓ 已具备')
check(ti.includes('✗ 缺失'), '必需缺失 → ✗ 缺失')
check(ti.includes('○ 未配置'), '可选缺失 → ○ 未配置')
check(ti.includes('缺少 1 项必需权限'), '汇总缺少必需权限数')
check(ti.includes('<th>权限</th>') && ti.includes('<th>必需</th>'), '表格含表头')
const tiOk = buildManagementTokenInfo(
  { ok: true, configured: true, name: 'Full', permissions: [{ ...manifestFixture[0], granted: true }] },
  manifestFixture,
)
check(tiOk.includes('必需权限齐全'), '全部满足 → 齐全提示')
// 不可读：表格仍在 + 提示用户补充（403 时明确点名 API Tokens · Read）
const unreadablePerms = [
  ...manifestFixture.map((p) => ({ ...p, granted: null })),
  { id: 'api-tokens-read', label: 'API Tokens · Read', reason: '读取本令牌名称与权限（本卡自检依赖此权限）', required: true, granted: false },
]
const tiUnreadable = buildManagementTokenInfo(
  {
    ok: true,
    configured: true,
    permissions: unreadablePerms,
    permissionsReadable: false,
    error: '403: Forbidden',
  },
  manifestFixture,
)
check(tiUnreadable.includes('未能读取令牌名称与权限'), '权限不可读 → 提示')
check(tiUnreadable.includes('User → API Tokens → Read'), '提示明确点名所需权限')
check(tiUnreadable.includes('token-perms-table') && tiUnreadable.includes('AI Gateway · Edit'), '不可读时仍渲染所需权限表格')
check(tiUnreadable.includes('API Tokens · Read') && tiUnreadable.includes('✗ 缺失'), '403 时 api-tokens-read 显示缺失')
check(buildManagementTokenInfo({ ok: true, configured: true, name: null, permissions: [] }, manifestFixture).includes('未知'), '名称缺失 → 未知')
// 每个状态都附「权限来源」说明（verify 免权限 / user-tokens 需 API Tokens · Read）
check(ti.includes('token-info-note') && ti.includes('/user/tokens'), '表格附权限来源说明')
// 附「网关页地址发现」权限来源说明（Workers Scripts / Zone · Read / Workers Routes · Read）
check(
  ti.includes('Cloudflare 网关') && ti.includes('自定义域名') && ti.includes('Workers Routes'),
  '表格附网关页自定义域名所需权限说明',
)

// ── 9：slotLabel ──────────────────────────────────────────
section('slotLabel')
check(slotLabel('management') === '管理 API Token', "management → '管理 API Token'")
check(slotLabel('gateway') === 'Gateway Token (cfut_xxx)', "gateway → 'Gateway Token (cfut_xxx)'")
check(slotLabel('foo') === 'foo', '非法值 → 原值透传')

// ── 10-11：导出存在性 + 回归 ──────────────────────────────
section('导出存在性')
for (const fn of [buildWorkersStatusView, buildAccountStatusView, buildManagementTokenInfo, slotLabel]) {
  check(typeof fn === 'function', `新纯函数 ${fn.name} 已导出`)
}
for (const fn of [api, registerViewRenderer, buildModelTableRows, buildProviderTableRows]) {
  check(typeof fn === 'function', `任务 30-32 导出 ${fn.name} 未破坏`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`❌ ${failures} 个断言失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
