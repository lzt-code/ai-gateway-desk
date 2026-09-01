/**
 * 任务 32 验证脚本：前端 Provider 视图纯函数
 *
 * 覆盖（交付包 §5.1 的 18 个用例 + 可见性迁移）：
 *  - buildProviderTableRows：三态 mark / type 映射 / enabled 列（status-toggle 按钮）/ 只读禁用 / 空数组
 *  - buildEditFields：custom 字段集 / byok 字段集 / 只读禁用云端字段（hidden 开关已迁移至列表状态列）
 *  - buildEditChanges：改名 / 云端启用 boolean / key 覆盖 / 改名+key / 改名无 key blocked / 无变化
 *  - buildLocalChanges：pathPrefix 变化 / 无变化 null（hidden 入参不再生效）
 *  - 导出存在性：4 个新函数 + 任务 30/31 导出回归
 *
 * 无 DOM 环境，视图交互（警告条 / 弹窗 / 删除确认 / 刷新按钮）由浏览器手工验收（交付包 §6）。
 */

const mod = await import('../src/web/public/app.js')
const {
  buildProviderTableRows,
  buildEditFields,
  buildEditChanges,
  buildLocalChanges,
  buildProviderLogText,
  buildProviderDetailLogs,
  api,
  showDialog,
  registerViewRenderer,
  buildModelTableRows,
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

// 键序无关的轻量对象断言
function eqObj(actual, expected) {
  if (!actual || typeof actual !== 'object') return false
  const aKeys = Object.keys(actual)
  const eKeys = Object.keys(expected)
  if (aKeys.length !== eKeys.length) return false
  return eKeys.every((k) => Object.prototype.hasOwnProperty.call(actual, k) && actual[k] === expected[k])
}

// ── fixtures（交付包 §4 样例）─────────────────────────────
const custom = { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true, mark: null }
const byok = { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: true, mark: null }
const newP = { id: 'deepseek', name: 'DeepSeek', type: 'byok', enabled: true, mark: 'new' }
const removedP = { id: 'sensenova', name: 'SenseNova', type: 'byok', enabled: true, mark: 'removed' }

// ── 1-5：buildProviderTableRows ───────────────────────────
section('buildProviderTableRows')

// 1：mark 标记不再作为表格列（云端新增/云端已删由日志栏展示）
const rows = buildProviderTableRows([newP, removedP, custom])
check(rows.length === 3, 'new/removed/null 各 1 → 行数 3')
const rowNew = rows.find((r) => r.id === 'deepseek')
const rowRemoved = rows.find((r) => r.id === 'sensenova')
const rowNull = rows.find((r) => r.id === 'agnes')
check(!!rowNew && !rowNew.html.includes('>新增<'), 'mark=new → 表格行不渲染「新增」列标记')
check(!!rowRemoved && !rowRemoved.html.includes('云端已删'), 'mark=removed → 表格行不渲染「云端已删」标记')

// 2：type 映射（custom-provider/byok）
check(!!rowNull && rowNull.html.includes('<td>Custom</td>'), 'custom-provider → 显示 Custom')
const byokRow = buildProviderTableRows([byok])[0]
check(!!byokRow && byokRow.html.includes('<td>BYOK</td>'), 'byok → 显示 BYOK')

// 3：可见性列（启用/隐藏 → 可点击切换的 status-toggle 按钮）
check(!!rowNull && rowNull.html.includes('>启用<'), 'custom 行 → 显示「启用」')
check(!!byokRow && byokRow.html.includes('>启用<'), 'byok 行 → 显示「启用」')
const hiddenRow = buildProviderTableRows([{ ...custom, enabled: false }])[0]
check(!!hiddenRow && hiddenRow.html.includes('隐藏'), 'enabled=false → 显示「隐藏」')
check(!!rowNull && rowNull.html.includes('class="status-toggle"'), '状态列为 status-toggle 按钮（点击切换）')
check(!!rowNull && rowNull.html.includes('title="点击切换启用/隐藏"'), '状态切换按钮带 title 提示')

// 4：只读禁用（状态切换/编辑/删除）
const roRows = buildProviderTableRows([custom], true)
check(roRows.length === 1 && (roRows[0].html.match(/disabled/g) || []).length >= 2, 'readonly=true → 状态/编辑/删除按钮均含 disabled')

check(Array.isArray(buildProviderTableRows([])) && buildProviderTableRows([]).length === 0, '空数组 → 返回 []')

// ── 6-8：buildEditFields ──────────────────────────────────
section('buildEditFields')

// 6：custom 字段集（name / baseUrl / apiKey / pathPrefix / slug；无 cloudEnabled；hidden 已迁移至列表）
const cf = buildEditFields(custom)
const cfNames = cf.map((f) => f.name)
check(cfNames.join(',') === 'name,baseUrl,apiKey,pathPrefix,slug', 'custom 字段序：name/baseUrl/apiKey/pathPrefix/slug')
check(cf.find((f) => f.name === 'slug').type === 'readonly', 'slug 为 readonly 类型')
check(!cfNames.includes('cloudEnabled'), 'custom 无 cloudEnabled 字段（云端启用已移除）')
check(!cfNames.includes('hidden'), 'custom 无 hidden 字段（可见性已迁移至列表状态列）')
check(cf.find((f) => f.name === 'pathPrefix').type === 'text', 'pathPrefix 为 text 类型')
check(cf.find((f) => f.name === 'pathPrefix').value === '', 'pathPrefix 预填为空（无 pathPrefix）')
check(cfNames.includes('apiKey'), 'custom 有 apiKey 字段')
const cKeyField = cf.find((f) => f.name === 'apiKey')
check(cKeyField.type === 'password' && cKeyField.placeholder.includes('留空不修改'), 'apiKey 为 password + placeholder「…留空不修改」')
check(cKeyField.value === '', 'apiKey 预填为空（仅覆盖不查看）')
const cBaseField = cf.find((f) => f.name === 'baseUrl')
check(cBaseField.type === 'text' && cBaseField.value === '', 'baseUrl 为 text，无云端 base_url 时预填为空')
check(typeof cBaseField.hint === 'string' && cBaseField.hint.includes('/v1'), 'baseUrl 带 hint，文案含 /v1')
const cBasePrefill = buildEditFields({ ...custom, base_url: 'https://api.example.com/v1' }).find((f) => f.name === 'baseUrl')
check(cBasePrefill.value === 'https://api.example.com/v1', 'baseUrl 预填云端 base_url（snake_case）')

// 7：byok 字段集（含 apiKey password；无 cloudEnabled；hidden 已迁移至列表）
const bf = buildEditFields(byok)
const bfNames = bf.map((f) => f.name)
check(bfNames.join(',') === 'name,apiKey,slug', 'byok 字段序：name/apiKey/slug')
const keyField = bf.find((f) => f.name === 'apiKey')
check(keyField.type === 'password' && keyField.placeholder.includes('留空不修改'), 'apiKey 为 password + placeholder「…留空不修改」')
check(keyField.value === '', 'apiKey 预填为空（仅覆盖不查看）')
check(!bfNames.includes('cloudEnabled'), 'byok 无 cloudEnabled 字段')
check(!bfNames.includes('hidden'), 'byok 无 hidden 字段（可见性已迁移至列表状态列）')

// 8：只读模式全部字段 disabled
const roCf = buildEditFields(custom, { readonly: true })
check(roCf.find((f) => f.name === 'name').disabled === true, 'readonly → name disabled')
check(roCf.find((f) => f.name === 'baseUrl').disabled === true, 'readonly → baseUrl disabled')
check(roCf.find((f) => f.name === 'pathPrefix').disabled === true, 'readonly → pathPrefix disabled')
const roBf = buildEditFields(byok, { readonly: true })
check(roBf.find((f) => f.name === 'apiKey').disabled === true, 'readonly → apiKey disabled')

// ── 9-13：buildEditChanges ────────────────────────────────
section('buildEditChanges')

// 9：custom 改名（apiKey/baseUrl 为 null 表示不修改）
check(
  eqObj(buildEditChanges(custom, { name: '新名' }), { name: '新名', apiKey: null, baseUrl: null }),
  'custom 改名 → {name:新名, apiKey:null, baseUrl:null}',
)
// 10：custom 传 cloudEnabled 不再生效（字段已移除，被忽略）
check(
  eqObj(buildEditChanges(custom, { cloudEnabled: false }), { name: null, apiKey: null, baseUrl: null }),
  'cloudEnabled 已移除 → {name:null, apiKey:null, baseUrl:null}（无该字段）',
)
// 11：byok 覆盖 key
check(
  eqObj(buildEditChanges(byok, { apiKey: 'sk-x' }), { name: null, apiKey: 'sk-x', baseUrl: null }),
  'byok 仅填 key → {name:null, apiKey:sk-x, baseUrl:null}',
)
// 12：byok 改名 + key
check(
  eqObj(buildEditChanges(byok, { name: '新', apiKey: 'sk-x' }), { name: '新', apiKey: 'sk-x', baseUrl: null }),
  'byok 改名 + key → {name:新, apiKey:sk-x, baseUrl:null}',
)
// 13：byok 改名无 key → blocked（含「同时提供新 Key」）
const blocked = buildEditChanges(byok, { name: '新', apiKey: '' })
check(!!blocked && typeof blocked.blocked === 'string' && blocked.blocked.includes('同时提供新 Key'), 'byok 改名无 key → 返回 blocked 文案（含「同时提供新 Key」）')
// 13b：byok 填 baseUrl → blocked（BYOK 不支持改 URL）
const byokBase = buildEditChanges(byok, { name: '', apiKey: '', baseUrl: 'https://x.com' })
check(!!byokBase && typeof byokBase.blocked === 'string' && byokBase.blocked.includes('Base URL'), 'byok 填 baseUrl → blocked（文案含 Base URL）')
// 13c：custom 改 baseUrl（与当前 base_url 不同）→ baseUrl 变更
const custBase = buildEditChanges({ ...custom, base_url: 'https://old.com' }, { name: '', apiKey: '', baseUrl: 'https://new.com' })
check(custBase && custBase.baseUrl === 'https://new.com' && custBase.name === null && custBase.apiKey === null, 'custom 改 baseUrl → {baseUrl:新值}（name/apiKey null）')
// 13d：custom baseUrl 未变 → baseUrl null
const custSame = buildEditChanges({ ...custom, base_url: 'https://same.com' }, { name: '', apiKey: '', baseUrl: 'https://same.com' })
check(custSame && custSame.baseUrl === null, 'custom baseUrl 未变 → baseUrl null')

// ── 14-16：buildLocalChanges（pathPrefix；hidden 开关已迁移至列表状态列）──
section('buildLocalChanges')

// 14：pathPrefix 变化 → 进入 localChanges
check(
  eqObj(buildLocalChanges(custom, { pathPrefix: '/api/v3' }), { pathPrefix: '/api/v3' }),
  'pathPrefix 变化 → {pathPrefix:新值}',
)
check(
  buildLocalChanges({ ...custom, pathPrefix: '/api/v3' }, { pathPrefix: '/api/v3' }) === null,
  'pathPrefix 无变化 → null（不发）',
)
// 15：pathPrefix 清空 → 空串（后端清除）
check(
  eqObj(buildLocalChanges({ ...custom, pathPrefix: '/api/v3' }, { pathPrefix: '' }), { pathPrefix: '' }),
  'pathPrefix 清空 → {pathPrefix:""}',
)
// 16：hidden 入参不再生效（可见性已迁移至列表状态列点击切换）
check(buildLocalChanges(custom, { hidden: true }) === null, 'hidden 入参不再生效 → null')
check(buildLocalChanges(custom, {}) === null, '空表单值 → null（不发）')

// ── 17-22：buildProviderLogText ──────────────────────────
section('buildProviderLogText')

// 17：开始拉取行（自动 / 手动）
check(
  buildProviderLogText({ force: false }) === '进入视图自动拉取 Provider 列表…',
  '进入视图自动拉取 → 文案「进入视图自动拉取 Provider 列表…」',
)
check(
  buildProviderLogText({ force: true }) === '手动更新 Provider 列表…',
  '手动更新 → 文案「手动更新 Provider 列表…」',
)
// 18：成功（云端合并，含数量）
const okText = buildProviderLogText({ force: true, ok: true, count: 6, readonly: false })
check(okText.includes('云端合并 6 个 Provider'), '成功 → 含「云端合并 6 个 Provider」')
// 19：成功但只读降级（云端拉取失败/无 Token，展示本地缓存）
const roText = buildProviderLogText({ force: false, ok: true, count: 6, readonly: true })
check(roText.includes('只读降级') && !roText.includes('6 个'), 'readonly → 含「只读降级」且不报云端数量')
// 20：失败（透传 api() 归一文案）
const errText = buildProviderLogText({ force: true, ok: false, error: '请求超时' })
check(errText.includes('拉取失败') && errText.includes('请求超时'), '失败 → 含「拉取失败」+ 错误文案')
// 21：失败无 error → 兜底文案
check(buildProviderLogText({ force: true, ok: false }) === '拉取失败：未知错误', '失败无 error → 「拉取失败：未知错误」')
// 22：缺省入参 → 自动拉取开始行（不抛错）
check(buildProviderLogText() === '进入视图自动拉取 Provider 列表…', '无入参 → 默认自动拉取开始行')

// ── 23-30：buildProviderDetailLogs（详细日志）─────────────
section('buildProviderDetailLogs')

// 23：开始行（含 type）
const startLogs = buildProviderDetailLogs({ force: true })
check(
  startLogs.length === 1 && startLogs[0].text === '手动更新 Provider 列表…' && startLogs[0].type === 'info',
  '开始行 → 「手动更新 Provider 列表…」type=info',
)
// 24：云端合并成功 → 摘要（Custom/BYOK 计数）+ 逐条 + type
const okLogs = buildProviderDetailLogs({
  force: true, ok: true, count: 2, readonly: false,
  providers: [custom, { ...byok, mark: 'new' }],
  sourceCounts: { custom: 1, byok: 1 },
})
check(
  okLogs[0].text === '拉取完成：云端合并 2 个 Provider（Custom 1 / BYOK 1）' && okLogs[0].type === 'ok',
  '摘要行 → 「云端合并 2 个 Provider（Custom 1 / BYOK 1）」type=ok',
)
check(
  okLogs.length === 3 && okLogs[1].text === 'Provider agnes「Agnes」（Custom）启用',
  'custom 行 → 「Provider agnes「Agnes」（Custom）启用」',
)
check(
  okLogs[2].text === 'Provider openrouter「OpenRouter」（BYOK）启用（云端新增）',
  'byok 新增行 → 「…（BYOK）启用（云端新增）」',
)
// 25：removed 标记行
const removedLog = buildProviderDetailLogs({
  force: false, ok: true, count: 1, readonly: false,
  providers: [removedP], sourceCounts: { byok: 1 },
})
check(
  removedLog[1].text.includes('（云端已删）') && removedLog[1].type === 'info',
  'removed 行 → 含「（云端已删）」type=info',
)
// 26：只读降级 no-token → 摘要 + 原因 + 本地行（启用状态）
const noTokenLogs = buildProviderDetailLogs({
  force: false, ok: true, count: 1, readonly: true,
  providers: [custom], degradedReason: 'no-token',
})
check(
  noTokenLogs[0].text === '拉取完成：只读降级，展示本地缓存 1 个 Provider' && noTokenLogs[0].type === 'warn',
  '只读降级摘要 → 「展示本地缓存 1 个 Provider」type=warn',
)
check(
  noTokenLogs[1].text.includes('未配置管理 API Token'),
  'no-token → 原因行含「未配置管理 API Token」',
)
check(
  noTokenLogs[2].text === 'Provider agnes「Agnes」（Custom）启用' && noTokenLogs[2].type === 'info',
  '本地缓存行 → 「Provider agnes「Agnes」（Custom）启用」（无云端语义）',
)
// 27：只读降级 fetch-failed → 透传云端错误
const fetchFailLogs = buildProviderDetailLogs({
  force: true, ok: true, count: 0, readonly: true,
  providers: [], degradedReason: 'fetch-failed',
  cloudErrors: [{ source: 'cloud', message: '云端不可达' }],
})
check(
  fetchFailLogs[1].text === '云端拉取失败：云端不可达' && fetchFailLogs[1].type === 'warn',
  'fetch-failed → 原因行「云端拉取失败：云端不可达」',
)
// 28：部分源失败 → warn 行（含源名与「合并结果可能不完整」）
const partialFailLogs = buildProviderDetailLogs({
  force: false, ok: true, count: 2, readonly: false,
  providers: [custom, byok], sourceCounts: { custom: 1, byok: 1 },
  cloudErrors: [{ source: 'provider_configs', message: '403 Forbidden' }],
})
check(
  partialFailLogs[partialFailLogs.length - 1].text === '[BYOK provider_configs] 拉取失败：403 Forbidden（合并结果可能不完整）'
    && partialFailLogs[partialFailLogs.length - 1].type === 'warn',
  '部分源失败 → 「[BYOK provider_configs] 拉取失败：403 Forbidden（合并结果可能不完整）」',
)
// 29：失败 → 单行 err
const failLogs = buildProviderDetailLogs({ force: true, ok: false, error: '请求超时' })
check(
  failLogs.length === 1 && failLogs[0].text === '拉取失败：请求超时' && failLogs[0].type === 'err',
  '失败 → 「拉取失败：请求超时」type=err',
)
// 30：缺省入参 → 不抛错（自动拉取开始行）
const defLogs = buildProviderDetailLogs()
check(
  defLogs.length === 1 && defLogs[0].text === '进入视图自动拉取 Provider 列表…',
  '无入参 → 默认自动拉取开始行',
)

// ── 17-18：导出存在性 + 回归 ──────────────────────────────
section('导出存在性')
for (const fn of [buildProviderTableRows, buildEditFields, buildEditChanges, buildLocalChanges, buildProviderLogText, buildProviderDetailLogs]) {
  check(typeof fn === 'function', `新纯函数 ${fn.name} 已导出`)
}
for (const fn of [api, showDialog, registerViewRenderer, buildModelTableRows]) {
  check(typeof fn === 'function', `任务 30/31 导出 ${fn.name} 未破坏`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`\n✗ ${failures} 个断言失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
