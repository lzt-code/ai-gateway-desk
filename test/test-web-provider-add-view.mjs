/**
 * 添加 Provider（FP4）验证脚本：前端添加视图纯函数
 *
 * 覆盖 12 用例：
 *  - buildAddFields：byok 3 字段（slug/name/apiKey）/ custom 5 字段（含 baseUrl/pathPrefix）/ 非法 type → []
 *  - buildAddPayload：trim / slug 正则校验 / byok 必有 apiKey / custom 必有 http(s) baseUrl /
 *    选填项为空不出现在 body / 成功 body 键集精确匹配
 *  - buildAddResultLogs：成功单行 ok / kvWarn 追加 warn 行（含 kvError）
 *  - 导出回归：3 个新函数 + 任务 32 既有导出
 *
 * 无 DOM 环境，添加弹窗交互（按钮 / 表单填值）由浏览器手工验收。
 */

const mod = await import('../src/web/public/app.js')
const {
  buildAddFields,
  buildAddPayload,
  buildAddResultLogs,
  buildEditFields,
  buildEditChanges,
  buildProviderTableRows,
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

// ── 1-3：buildAddFields ──────────────────────────────────
section('buildAddFields')

// 1：byok → 3 字段，顺序 slug/name/apiKey，apiKey 为 password
const bf = buildAddFields('byok')
check(bf.length === 3, 'byok → 字段数 3')
check(bf.map((f) => f.name).join(',') === 'slug,name,apiKey', 'byok 字段序 slug/name/apiKey')
check(bf[0].type === 'text' && bf[0].placeholder.includes('openai'), 'slug 为 text，占位含「如 openai / anthropic / deepseek」')
check(bf[1].placeholder === '缺省同 slug', 'name 占位「缺省同 slug」')
check(bf[2].type === 'password', 'apiKey 为 password')

// 2：custom-provider → 5 字段，含 baseUrl/pathPrefix
const cf = buildAddFields('custom-provider')
check(cf.length === 5, 'custom-provider → 字段数 5')
check(cf.map((f) => f.name).join(',') === 'slug,name,baseUrl,apiKey,pathPrefix', 'custom 字段序 slug/name/baseUrl/apiKey/pathPrefix')
check(cf[2].type === 'text' && cf[2].placeholder === 'https://…', 'baseUrl 为 text，占位「https://…」')
check(typeof cf[2].hint === 'string' && cf[2].hint.includes('/v1') && cf[2].hint.includes('火山方舟'), 'baseUrl 带 hint：含 /v1 说明与火山方舟示例')
check(cf[3].type === 'password' && cf[3].placeholder.includes('可留空'), 'apiKey 为 password，占位含「可留空」')
check(cf[4].type === 'text' && cf[4].placeholder === '如 /api/v3，留空使用默认 /v1', 'pathPrefix 占位与 buildEditFields 一致')

// 3：非法 type → []
check(Array.isArray(buildAddFields('nope')) && buildAddFields('nope').length === 0, "非法 type 'nope' → []")
check(Array.isArray(buildAddFields(undefined)) && buildAddFields(undefined).length === 0, 'undefined → []')

// ── 4-9：buildAddPayload ─────────────────────────────────
section('buildAddPayload')

// 4：byok 合法、name 空 → body 恰为 { type, id, apiKey }（name 键不出现）
check(
  eqObj(buildAddPayload('byok', { slug: 'openai', name: '', apiKey: 'sk-x' }).body, { type: 'byok', id: 'openai', apiKey: 'sk-x' }),
  'byok 合法（name 空）→ body 恰为 {type,id,apiKey}',
)

// 5：byok 带 name → body.name 透出且已 trim
check(
  eqObj(buildAddPayload('byok', { slug: 'openai', name: '  OpenAI  ', apiKey: ' sk-x ' }).body, { type: 'byok', id: 'openai', name: 'OpenAI', apiKey: 'sk-x' }),
  'byok 带 name → body.name 透出且 trim',
)

// 6：byok 缺 apiKey / 非法 slug → blocked（文案可读非空）
const noKey = buildAddPayload('byok', { slug: 'openai', name: '', apiKey: '' })
check(!!noKey && typeof noKey.blocked === 'string' && noKey.blocked.length > 0, 'byok 缺 apiKey → 返回 blocked（文案非空）')
check(!!noKey && noKey.blocked.includes('API Key'), 'byok 缺 apiKey → 文案提示填 API Key')
const badSlug = buildAddPayload('byok', { slug: 'Bad Slug!', name: '', apiKey: 'sk-x' })
check(!!badSlug && typeof badSlug.blocked === 'string' && badSlug.blocked.includes('Provider ID'), '非法 slug → blocked（文案提示 Provider ID）')
check(
  buildAddPayload('byok', { slug: 'openai_1', name: '', apiKey: 'sk-x' }).blocked != null,
  '含下划线的 slug → blocked',
)

// 7：custom 全填 → body 含 baseUrl/apiKey/pathPrefix
check(
  eqObj(
    buildAddPayload('custom-provider', { slug: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', pathPrefix: '/v3' }).body,
    { type: 'custom-provider', id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x', pathPrefix: '/v3' },
  ),
  'custom 全填 → body 含 baseUrl/apiKey/pathPrefix',
)

// 8：custom 缺 baseUrl / baseUrl 非 http(s) → blocked
const noBase = buildAddPayload('custom-provider', { slug: 'deepseek', name: '', baseUrl: '', apiKey: '', pathPrefix: '' })
check(!!noBase && typeof noBase.blocked === 'string' && noBase.blocked.includes('Base URL'), 'custom 缺 baseUrl → blocked（文案提示 Base URL）')
const badBase = buildAddPayload('custom-provider', { slug: 'deepseek', name: '', baseUrl: 'ftp://x', apiKey: '', pathPrefix: '' })
check(!!badBase && typeof badBase.blocked === 'string' && badBase.blocked.includes('http'), 'baseUrl 非 http(s) → blocked（文案含 http）')
check(
  buildAddPayload('custom-provider', { slug: 'deepseek', name: '', baseUrl: 'http://127.0.0.1:8080', apiKey: '', pathPrefix: '' }).body.baseUrl === 'http://127.0.0.1:8080',
  'baseUrl 为 http:// 也算合法',
)

// 9：custom 选填全空 → body 恰为 { type, id, baseUrl }
check(
  eqObj(
    buildAddPayload('custom-provider', { slug: 'deepseek', name: '   ', baseUrl: 'https://api.deepseek.com', apiKey: '', pathPrefix: '  ' }).body,
    { type: 'custom-provider', id: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  ),
  'custom 选填全空 → body 恰为 {type,id,baseUrl}',
)

// ── 10-11：buildAddResultLogs ────────────────────────────
section('buildAddResultLogs')

// 10：kvWarn=false → 单行 ok，含 id 与「BYOK」
const okLogs = buildAddResultLogs({ id: 'openai', type: 'byok', kvWarn: false })
check(
  okLogs.length === 1 && okLogs[0].type === 'ok' && okLogs[0].text.includes('openai') && okLogs[0].text.includes('BYOK'),
  'kvWarn=false → 单行 ok，含 id 与「BYOK」',
)
check(
  buildAddResultLogs({ id: 'agnes', type: 'custom-provider', kvWarn: false })[0].text.includes('Custom'),
  'custom-provider → 文案含「Custom」',
)

// 11：kvWarn=true → 两行，第二行 warn 含 kvError
const warnLogs = buildAddResultLogs({ id: 'openai', type: 'byok', kvWarn: true, kvError: 'KV write timeout' })
check(
  warnLogs.length === 2 && warnLogs[0].type === 'ok',
  'kvWarn=true → 两行，首行仍为 ok',
)
check(
  warnLogs[1].type === 'warn'
    && warnLogs[1].text.includes('KV write timeout')
    && warnLogs[1].text.includes('部署更改'),
  '第二行 warn 含 kvError 与「部署更改」提示',
)

// ── 12：导出存在性 + 回归 ────────────────────────────────
section('导出存在性')
for (const fn of [buildAddFields, buildAddPayload, buildAddResultLogs]) {
  check(typeof fn === 'function', `新纯函数 ${fn.name} 已导出`)
}
for (const fn of [buildEditFields, buildEditChanges, buildProviderTableRows, buildProviderLogText, buildProviderDetailLogs]) {
  check(typeof fn === 'function', `任务 32 既有导出 ${fn.name} 未破坏`)
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