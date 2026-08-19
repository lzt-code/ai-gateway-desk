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

// ── 9：slotLabel ──────────────────────────────────────────
section('slotLabel')
check(slotLabel('management') === '管理 API Token', "management → '管理 API Token'")
check(slotLabel('gateway') === 'Gateway Token (cfut_xxx)', "gateway → 'Gateway Token (cfut_xxx)'")
check(slotLabel('foo') === 'foo', '非法值 → 原值透传')

// ── 10-11：导出存在性 + 回归 ──────────────────────────────
section('导出存在性')
for (const fn of [buildWorkersStatusView, buildAccountStatusView, slotLabel]) {
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
