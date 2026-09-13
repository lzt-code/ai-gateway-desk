/**
 * 任务 30 验证脚本：前端页面骨架
 *
 * 覆盖（交付包 §5 的 20 个用例）：
 *  - index.html / style.css 结构断言（选项卡契约 / 视图容器 / 进度面板 / 提示栏 /
 *    模块引用 / 主题变量 / 布局要点 / 健康检查回归）
 *  - app.js 纯函数单测（import 不触发 DOM；api() 用 mock fetch；弹窗仅 typeof 检查）
 *
 * 无 DOM 环境，交互行为（选项卡点击、弹窗、flash）由浏览器手工验收（交付包 §6）。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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

// ── 1-5：index.html 结构断言 ──────────────────────────────
section('index.html 结构断言')
const htmlPath = path.join(ROOT, 'src', 'web', 'public', 'index.html')
const html = await readFile(htmlPath, 'utf8')
check(html.length > 0, 'index.html 存在且非空')

const viewButtons = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1])
check(viewButtons.length === 5, '含 5 个 data-view 按钮契约（providers/models/routes/workers/account）')
check(
  JSON.stringify(viewButtons) === JSON.stringify(['providers', 'models', 'routes', 'workers', 'account']),
  'data-view 顺序与 VIEW_ORDER 一致（routes 紧随 models 之后）',
)

for (const v of ['providers', 'models', 'routes', 'workers', 'account']) {
  const re = new RegExp(`<section\\s+class="view"\\s+id="view-${v}"\\s+hidden>`)
  check(re.test(html), `视图容器 <section class="view" id="view-${v}" hidden>`)
}

check(
  html.includes('id="progress-panel"') && html.includes('hidden'),
  '进度面板 id="progress-panel"（hidden）',
)
check(html.includes('id="hint-bar"'), '提示栏 id="hint-bar"')
check(html.includes('id="activity-log"'), '底部处理过程日志栏 id="activity-log"')
check(
  html.includes('id="activity-log-body"') && html.includes('id="btn-log-clear"') && html.includes('id="btn-log-toggle"'),
  '日志栏正文/清空/收起按钮骨架（activity-log-body / btn-log-clear / btn-log-toggle）',
)
check(/<script\s+type="module"\s+src="app\.js">/.test(html), '含 <script type="module" src="app.js">')
check(/<link\s+rel="stylesheet"\s+href="style\.css">/.test(html), '含 <link rel="stylesheet" href="style.css">')
check(html.includes('id="flash-root"'), 'flash 挂载点 id="flash-root"')
check(
  html.includes('id="busy-indicator"') && html.includes('hidden') &&
    html.includes('id="busy-text"') && html.includes('class="busy-spinner"'),
  '全局加载指示骨架（busy-indicator hidden / busy-text / busy-spinner）',
)

// ── 6：style.css 主题 + 布局要点 ──────────────────────────
section('style.css 主题变量与布局')
const cssPath = path.join(ROOT, 'src', 'web', 'public', 'style.css')
const css = await readFile(cssPath, 'utf8')
check(css.length > 0, 'style.css 存在且非空')
check(/:root\s*\{/.test(css), '含 :root 变量块')
for (const v of ['--bg', '--panel', '--fg', '--muted', '--accent', '--ok', '--warn', '--err', '--border']) {
  check(css.includes(`${v}:`), `主题变量 ${v}`)
}
check(/\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css), '[hidden] display:none !important（已知坑 8）')
check(/grid-template-columns\s*:\s*1fr\s+280px/.test(css), '主区 grid 1fr + 280px 提示栏')
check(/@media\s*\(max-width\s*:\s*900px\)/.test(css), '<900px 响应式断点')
check(/\.tab-bar\s+button\.active|button\.active/.test(css), '选项卡激活态样式 .active')
check(/\.busy-spinner\s*\{/.test(css) && /@keyframes\s+busy-spin/.test(css), '转圈圈动画样式（.busy-spinner + @keyframes busy-spin）')

// ── 7-19：app.js 纯函数单测 ───────────────────────────────
section('app.js 纯函数单测')
const mod = await import('../src/web/public/app.js')
const {
  VIEWS,
  VIEW_ORDER,
  VIEW_LABELS,
  VIEW_HINTS,
  createState,
  ApiError,
  api,
  showDialog,
  confirmDialog,
  promptDialog,
  normalizeSelectOptions,
  flash,
  logActivity,
  clearActivityLog,
  registerViewRenderer,
  switchView,
  renderView,
  start,
  HEARTBEAT_INTERVAL,
  startHeartbeat,
  sendGoodbye,
  showBusy,
  hideBusy,
  withBusy,
} = mod
check(true, 'app.js 可被 Node import（顶层无 DOM 访问，能加载即证明）')

// 8z：全局加载指示（转圈圈）纯函数（showBusy / hideBusy / withBusy）
check(typeof showBusy === 'function' && typeof hideBusy === 'function', 'showBusy/hideBusy 已导出（全局加载指示）')
check(typeof withBusy === 'function', 'withBusy 已导出（异步包装自动显隐）')
const busyResult = await withBusy('处理中', Promise.resolve(42))
check(busyResult === 42, 'withBusy 透传 Promise 结果（无 DOM 环境）')

// 8a：底部处理过程日志栏纯函数（logActivity / clearActivityLog）
check(typeof logActivity === 'function', 'logActivity 已导出（底部处理过程日志栏）')
check(typeof clearActivityLog === 'function', 'clearActivityLog 已导出')
check(logActivity('测试日志') === false, 'logActivity 无 DOM 环境返回 false（顶层零 DOM 访问）')

// 8：VIEWS / VIEW_ORDER / VIEW_LABELS
check(
  Object.keys(VIEWS).length === 5 && Object.values(VIEWS).every((v) => VIEW_ORDER.includes(v)),
  'VIEWS 五视图常量且均含于 VIEW_ORDER',
)
check(
  VIEW_ORDER.length === 5 &&
    ['providers', 'models', 'routes', 'workers', 'account'].every((v) => VIEW_ORDER.includes(v)),
  'VIEW_ORDER 长度 5 且含全部 5 个视图名',
)
check(
  VIEW_LABELS.providers === 'Provider' &&
    VIEW_LABELS.models === '模型' &&
    VIEW_LABELS.routes === '动态路由' &&
    VIEW_LABELS.workers === 'Worker' &&
    VIEW_LABELS.account === '账户',
  'VIEW_LABELS 文案（含 模型 / 动态路由）',
)

// 9：VIEW_HINTS 覆盖全部视图
check(
  JSON.stringify(Object.keys(VIEW_HINTS).sort()) === JSON.stringify([...VIEW_ORDER].sort()),
  'VIEW_HINTS 键集合与 VIEW_ORDER 一致',
)

// 10：createState 基础
{
  const s = createState()
  check(s.currentView === null, 'createState() 默认 currentView === null')
  s.setView('models')
  check(s.currentView === 'models', 'setView 后 currentView 更新')
  s.set('filter', 'gpt')
  check(s.get('filter') === 'gpt', 'set/get 往返')
  check(s.data.filter === 'gpt', '内部 data 存储可断言')
  s.setView('not-a-view')
  check(s.currentView === 'models', 'setView 非法视图不生效')
}

// 11-15：api()（mock fetch，测完恢复）
const origFetch = globalThis.fetch
try {
  {
    // 11：参数组装
    const seen = []
    globalThis.fetch = async (url, opts) => {
      seen.push({ url, opts })
      return { ok: true, status: 200, json: async () => ({}) }
    }
    await api('/api/x')
    check(
      seen[0].opts.method === 'GET' &&
        seen[0].opts.body === undefined &&
        seen[0].opts.headers['Content-Type'] === undefined,
      'GET 无 body、无 content-type',
    )
    await api('/api/x', { method: 'POST', body: { a: 1 } })
    check(
      seen[1].opts.method === 'POST' &&
        seen[1].opts.body === JSON.stringify({ a: 1 }) &&
        seen[1].opts.headers['Content-Type'] === 'application/json',
      'POST 有 JSON.stringify body + content-type',
    )
    await api('/api/x', { signal: 'sig-1' })
    check(seen[2].opts.signal === 'sig-1', 'signal 透传给 fetch')
  }
  {
    // 12：2xx 解析
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    const data = await api('/api/x')
    check(data && data.ok === true, 'api() 2xx 返回 parsed JSON')
  }
  {
    // 13：非 2xx 抛 ApiError（message 取后端 error 字段）
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'model not found' }),
    })
    try {
      await api('/api/x')
      check(false, '非 2xx 应抛错')
    } catch (err) {
      check(err instanceof ApiError, '非 2xx 抛 ApiError')
      check(err.message === 'model not found', 'err.message 取后端 error 字段')
      check(err.status === 404, 'err.status === 404')
    }
  }
  {
    // 14：后端无 error 字段 → 消息含状态码
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
    try {
      await api('/api/x')
      check(false, '无 error 字段也应抛错')
    } catch (err) {
      check(err instanceof ApiError && String(err.message).includes('500'), 'message 含 500')
    }
  }
  {
    // 15：网络失败
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    try {
      await api('/api/x')
      check(false, '网络失败应抛错')
    } catch (err) {
      check(
        err instanceof ApiError && err.status === 0 && String(err.message).includes('网络'),
        '网络失败 → status 0 + message 含 网络',
      )
    }
  }
  {
    // 15b：AbortError（调用方超时中止）→ 归一到「请求超时」
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    globalThis.fetch = async () => {
      throw abortErr
    }
    try {
      await api('/api/x')
      check(false, 'AbortError 应抛错')
    } catch (err) {
      check(
        err instanceof ApiError && err.status === 0 && String(err.message).includes('超时'),
        'AbortError → status 0 + message 含 超时',
      )
    }
  }
} finally {
  globalThis.fetch = origFetch
}

// 16：弹窗组件存在且为函数（Node 无 DOM，不调用）
for (const fn of [showDialog, confirmDialog, promptDialog, flash]) {
  check(typeof fn === 'function', `组件 ${fn.name} 存在且为函数`)
}

// 17：registerViewRenderer 分派表
{
  let calls = 0
  registerViewRenderer('models', () => {
    calls++
  })
  renderView('models')
  check(calls === 1, 'registerViewRenderer 后 renderView 调用渲染函数')
  renderView('models')
  check(calls === 1, '重复 renderView 同一视图不重复渲染（懒渲染幂等）')
  let threw = false
  try {
    renderView('not-a-view')
  } catch {
    threw = true
  }
  check(!threw, '未注册/非法视图 renderView 不抛错')
}

// 18：switchView 切换逻辑
{
  let calls = 0
  registerViewRenderer('workers', () => {
    calls++
  })
  const s1 = switchView('workers')
  check(s1.currentView === 'workers', 'switchView 后当前视图更新')
  check(calls === 1, '首次切换触发渲染')
  const s2 = switchView('workers')
  check(s2.currentView === 'workers' && calls === 1, '重复切换同一视图幂等（不重复渲染）')
  const s3 = switchView('providers')
  check(s3.currentView === 'providers', '再次切换其他视图状态更新')
}

// 19：start 存在且为函数
check(typeof start === 'function', 'start 存在且为函数（Node 导入不执行）')

// 19b：心跳（服务器自动退出配套，桌面应用式关闭语义）
{
  check(HEARTBEAT_INTERVAL > 0, 'HEARTBEAT_INTERVAL 为正数（需小于服务器心跳超时）')
  let calls = 0
  const seen = []
  const mockFetch = async (url, opts) => {
    calls++
    seen.push({ url, opts })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const stop = startHeartbeat({ interval: 5, url: '/api/heartbeat', fetchFn: mockFetch })
  await new Promise((r) => setTimeout(r, 25))
  check(calls >= 2, `startHeartbeat 周期上报（实际 ${calls} 次，含首帧立即上报）`)
  check(
    seen[0].url === '/api/heartbeat' &&
      seen[0].opts.method === 'POST' &&
      seen[0].opts.keepalive === true,
    '心跳 POST /api/heartbeat + keepalive:true（卸载瞬间也尽量送达）',
  )
  const before = calls
  stop()
  await new Promise((r) => setTimeout(r, 15))
  check(calls === before, 'stop() 后停止上报')
  check(sendGoodbye() === false, 'Node 无 navigator → sendGoodbye 返回 false（不抛错）')
}

// ── 20：健康检查回归（任务 25 占位逻辑保留） ────────────────
section('健康检查回归（任务 25）')
check(html.includes('id="health-status"'), 'index.html 保留健康检查标记 #health-status')
check(html.includes('/api/health'), 'index.html 保留 /api/health 健康检查逻辑')

// ── 21：normalizeSelectOptions 纯函数（FP3 select 字段选项归一化） ──
section('normalizeSelectOptions（FP3 select 选项归一化）')
check(typeof normalizeSelectOptions === 'function', 'normalizeSelectOptions 已导出且为函数')
check(
  JSON.stringify(normalizeSelectOptions(['byok', 'custom-provider'])) ===
    JSON.stringify([
      { value: 'byok', label: 'byok' },
      { value: 'custom-provider', label: 'custom-provider' },
    ]),
  '字符串数组 → [{value,label}]（value===label）',
)
check(
  JSON.stringify(
    normalizeSelectOptions([
      { value: 'byok', label: 'BYOK 密钥' },
      { value: 'custom', label: '自定义' },
    ]),
  ) ===
    JSON.stringify([
      { value: 'byok', label: 'BYOK 密钥' },
      { value: 'custom', label: '自定义' },
    ]),
  '对象数组 → 原样规范化输出（label 保留）',
)
check(
  JSON.stringify(normalizeSelectOptions(['ok', null, { value: 'a', label: 'A' }, 42, { label: '缺 value' }, { value: null, label: 'null value' }, 'ko'])) ===
    JSON.stringify([
      { value: 'ok', label: 'ok' },
      { value: 'a', label: 'A' },
      { value: 'ko', label: 'ko' },
    ]),
  '混合数组：null/数字/缺 value 对象等非法项被过滤',
)
check(JSON.stringify(normalizeSelectOptions(undefined)) === '[]', 'undefined → []')
check(JSON.stringify(normalizeSelectOptions('byok')) === '[]', '非数组（字符串）→ []')
check(JSON.stringify(normalizeSelectOptions(null)) === '[]', '非数组（null）→ []')

// ── 22：同步变更明细：对象值展开为子字段行 ──────────────────
section('同步变更明细（expandFieldChanges / buildSyncDiffHtml）')
const { expandFieldChanges, buildSyncDiffHtml, formatPriceDisplay } = mod
check(typeof expandFieldChanges === 'function', 'expandFieldChanges 已导出且为函数')

{
  // pricing 对象值：仅 prompt 变化 → 展开为 pricing.prompt 单行标量新旧值
  const rows = expandFieldChanges([
    { field: 'pricing', oldValue: { prompt: 0.000002, completion: 0.000004 }, newValue: { prompt: 0.000001, completion: 0.000004 } },
  ])
  check(
    rows.length === 1 && rows[0].field === 'pricing.prompt' &&
      rows[0].oldValue === 0.000002 && rows[0].newValue === 0.000001,
    'pricing 仅 prompt 变化 → 单行 pricing.prompt（completion 相同被跳过）',
  )
}

{
  // 两层嵌套：pricings.agent.prompt / pricings.fast.*（agent.completion 未变被跳过）
  const rows = expandFieldChanges([
    {
      field: 'pricings',
      oldValue: { agent: { prompt: 2, completion: 4 } },
      newValue: { agent: { prompt: 0.5, completion: 4 }, fast: { prompt: 1, completion: 2 } },
    },
  ])
  const fields = rows.map((r) => r.field).sort()
  check(
    JSON.stringify(fields) === JSON.stringify(['pricings.agent.prompt', 'pricings.fast.completion', 'pricings.fast.prompt']),
    '两层嵌套展开为点路径子字段（新增子对象也展开，相同子字段跳过）',
  )
  const row = rows.find((r) => r.field === 'pricings.agent.prompt')
  check(row && row.oldValue === 2 && row.newValue === 0.5, '子字段保留标量新旧值（2 → 0.5）')
}

{
  // 字段新增（旧值 undefined）：展开后旧值仍为 undefined
  const rows = expandFieldChanges([{ field: 'pricing', oldValue: undefined, newValue: { prompt: 0.5, completion: 1 } }])
  const fields = rows.map((r) => r.field).sort()
  check(
    JSON.stringify(fields) === JSON.stringify(['pricing.completion', 'pricing.prompt']),
    '对象字段新增 → 子字段行（旧值 undefined）',
  )
  check(rows.every((r) => r.oldValue === undefined), '新增子字段旧行值为 undefined')
}

{
  // 数组 / 类型不匹配：整体回退为原值行，不展开
  const rows = expandFieldChanges([
    { field: 'tags', oldValue: ['a', 'b'], newValue: ['a', 'c'] },
    { field: 'note', oldValue: 'x', newValue: { a: 1 } },
  ])
  check(rows.length === 2 && rows.every((r) => !r.field.includes('.')), '数组/类型不匹配 → 原值行回退（不展开）')
  check(JSON.stringify(rows[0].oldValue) === '["a","b"]', '数组值原样透传')
}

{
  // 超深度：展开停止在 maxDepth 层，更深子对象以原值整体展示
  const rows = expandFieldChanges([
    { field: 'deep', oldValue: { a: { b: { c: 1 } } }, newValue: { a: { b: { c: 2 } } } },
  ], 1)
  check(
    rows.length === 1 && rows[0].field === 'deep.a' &&
      JSON.stringify(rows[0].oldValue) === '{"b":{"c":1}}',
    '超深度 → 停止展开，剩余子对象整体作为旧/新值',
  )
}

{
  // 标量变化（status 等）原样透传
  const rows = expandFieldChanges([{ field: 'status', oldValue: 'selected', newValue: 'hidden' }])
  check(rows.length === 1 && rows[0].field === 'status' && rows[0].newValue === 'hidden', '标量变化原样透传')
}

{
  // 表格 HTML：对象值渲染为子字段行，而非整段 JSON；与调试开关无关始终展示新旧值
  const html = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'openrouter/m1',
        provider: 'openrouter',
        changes: [{ field: 'pricing', oldValue: { prompt: 0.000002, completion: 0.000004 }, newValue: { prompt: 0.000001, completion: 0.000004 } }],
      },
    ],
  })
  check(html.includes('pricing.prompt'), '表格含子字段列 pricing.prompt')
  check(
    html.includes('>2</mark> /M tokens') && html.includes('>1</mark> /M tokens'),
    '价格数值换算为 $/M tokens 展示（$2 → $1，字符级高亮拆分）',
  )
  check(!html.includes('0.000002') && !html.includes('0.000001'), '价格不再展示原始科学计数法/长小数形式')
  check(!html.includes('completion'), '未变化的子字段不出现（无整段 JSON）')
  check(html.includes('<th>旧值</th>') && html.includes('<th>新值</th>'), '字段变化表始终含旧值/新值列（与调试开关无关）')
  check(!html.includes('（调试）') && !html.includes('（简要）'), '标题无调试/简要模式区分')
}

{
  // 价格换算纯函数：扁平 per-token / per-M 量级启发式 + 结构化 unit/currency
  check(formatPriceDisplay(6.538e-8) === '$0.06538 /M tokens', '6.538e-8（per-token）→ $0.06538 /M tokens（科学计数法换算）')
  check(formatPriceDisplay(1.3076e-7) === '$0.13076 /M tokens', '1.3076e-7（per-token）→ $0.13076 /M tokens')
  check(formatPriceDisplay('0.000000049') === '$0.049 /M tokens', '字符串价格 "0.000000049"（per-token）→ $0.049 /M tokens')
  check(formatPriceDisplay(0.00001) === '$10 /M tokens', '1e-5（per-token 实测上限）→ ×1e6 → $10 /M tokens')
  check(formatPriceDisplay(0.005) === '$0.005 /M tokens', '0.005（阈值边界）→ per-M 原样 → $0.005 /M tokens')
  check(formatPriceDisplay(0.05) === '$0.05 /M tokens', '0.05（per-M 实测下限）→ $0.05 /M tokens（不再 ×1e6）')
  check(formatPriceDisplay(5) === '$5 /M tokens', '5（opus-4-x per-M 存量）→ $5 /M tokens（原样展示）')
  check(formatPriceDisplay(0.45) === '$0.45 /M tokens', '0.45（per-M）→ $0.45 /M tokens')
  check(formatPriceDisplay(0) === '$0 /M tokens', '0 → $0 /M tokens（免费模型，两种单位下同为 0）')
  check(formatPriceDisplay(-1) === null, '"-1" 变量计价 → null（不换算，原样展示）')
  check(formatPriceDisplay('free') === null, '非数值串 → null')
  check(formatPriceDisplay(undefined) === null && formatPriceDisplay(null) === null, 'undefined/null → null（字段增删侧原样展示）')

  // 结构化价格（pricings 子字段数组）：读显式 unit / currency
  check(
    formatPriceDisplay([{ value: 2.5, unit: 'perMTokens', currency: 'USD' }]) === '$2.5 /M tokens',
    '结构化 perMTokens USD → $2.5 /M tokens（值已是 per-M，不 ×1e6）',
  )
  check(
    formatPriceDisplay([{ value: 0.66, unit: 'perMTokens', currency: 'USD' }, { value: 1.32, unit: 'perMTokens', currency: 'USD' }]) === '$0.66 / $1.32 /M tokens',
    '多档价格数组 → 各档以 / 连接展示',
  )
  check(
    formatPriceDisplay([{ value: 0.03, unit: 'perSecond', currency: 'CNY' }]) === '¥0.03 perSecond',
    '非 token 计价（perSecond CNY）→ ¥ 符号 + 原单位展示',
  )
  check(formatPriceDisplay([{ value: 0.5 }]) === '$0.5', '结构化缺 currency → 与扁平一致按 USD 假设')
  check(formatPriceDisplay([{}]) === null && formatPriceDisplay([]) === null, '结构化数组含非法项/为空 → null（原样回退）')

  // 表格：per-M 扁平存量价格不再 ×1e6（opus-4-x 实测形态）
  const html4 = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'custom-opencode/claude-opus-4-8',
        provider: 'custom-opencode',
        changes: [{ field: 'pricing', oldValue: { prompt: 5, completion: 25 }, newValue: { prompt: 6, completion: 25 } }],
      },
    ],
  })
  check(
    html4.includes('>5</mark> /M tokens') && html4.includes('>6</mark> /M tokens'),
    'per-M 存量价格展示为 $5 → $6 /M tokens（不 ×1e6）',
  )
  check(!html4.includes('5000000'), '不再出现 $5000000 量级的错误换算')

  // 表格：结构化 pricings（数组值，读 unit/currency）
  const html5 = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'custom-zenmux/google/gemini-3.7-flash',
        provider: 'custom-zenmux',
        changes: [{ field: 'pricings', oldValue: { prompt: [{ value: 0.15, unit: 'perMTokens', currency: 'USD' }] }, newValue: { prompt: [{ value: 0.1, unit: 'perMTokens', currency: 'USD' }] } }],
      },
    ],
  })
  check(
    html5.includes('pricings.prompt') && html5.includes('$0.1') && html5.includes('>5</mark> /M tokens'),
    '结构化 pricings 数组 → 按显式 unit 展示 $0.15 → $0.1 /M tokens（5 高亮）',
  )

  // 表格：audio 等按次/按秒计价子字段不套 $/M tokens
  const html6 = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'prov/m1',
        provider: 'prov',
        changes: [{ field: 'pricing', oldValue: { audio: 5 }, newValue: { audio: 6 } }],
      },
    ],
  })
  check(
    html6.includes('pricing.audio') && html6.includes('>5</mark>') && html6.includes('>6</mark>') && !html6.includes('/M tokens'),
    '非 token 计价子字段（audio）原样展示（不套 $/M tokens）',
  )

  // 表格：字段增删（单侧 undefined）时价格侧换算、缺失侧展示 —
  const html2 = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'custom-opencode/deepseek-v4-flash',
        provider: 'custom-opencode',
        changes: [
          { field: 'pricing', oldValue: undefined, newValue: { prompt: 4.9e-8, completion: 9.8e-8 } },
        ],
      },
    ],
  })
  check(html2.includes('$0.049 /M tokens') && html2.includes('$0.098 /M tokens'), '字段新增：新值侧换算为 $/M tokens')
  check(html2.includes('—'), '缺失旧值侧展示 —（原样回退）')

  // 非价格字段不受换算影响
  const html3 = buildSyncDiffHtml({
    added: [],
    removed: [],
    updated: [
      {
        modelId: 'prov/m1',
        provider: 'prov',
        changes: [{ field: 'context_length', oldValue: 64000, newValue: 128000 }],
      },
    ],
  })
  check(html3.includes('>64</mark>000') && html3.includes('>128</mark>000') && !html3.includes('/M tokens'), '非价格字段数值原样展示（不换算）')
}

// ── 23：变更明细重开（查看变更明细按钮）────────────────────
section('变更明细重开（mbtn-show-diff / hideSyncDiffPanel）')
check(
  html.includes('id="mbtn-show-diff"') && html.includes('查看变更明细'),
  'index.html 模型侧栏含「查看变更明细」按钮（mbtn-show-diff）',
)
{
  const { hideSyncDiffPanel, updateShowDiffButton } = mod
  check(typeof hideSyncDiffPanel === 'function' && typeof updateShowDiffButton === 'function', 'hideSyncDiffPanel / updateShowDiffButton 已导出')
  const appjs = await readFile(path.join(ROOT, 'src', 'web', 'public', 'app.js'), 'utf8')
  check(appjs.includes('btnShowDiff.addEventListener'), '模型视图绑定「查看变更明细」点击重开')
  // × 关闭不再清空 lastSyncDetails（数据保留供重开），清空仅发生在 clearSyncDiffPanel
  const renderSrc = appjs.slice(appjs.indexOf('export function renderSyncDiffToPanel'), appjs.indexOf('export function hideSyncDiffPanel'))
  check(renderSrc.includes('hideSyncDiffPanel()'), '明细面板 × 关闭仅隐藏（hideSyncDiffPanel，保留数据）')
  check(!renderSrc.includes("set('lastSyncDetails', null)"), '× 关闭不再清空 lastSyncDetails')
  // 最小 DOM mock：无缓存明细 → 按钮禁用 + 提示文案；面板元素缺失时安全跳过
  const btn = { disabled: false, title: '' }
  globalThis.document = { getElementById: (id) => (id === 'mbtn-show-diff' ? btn : null) }
  try {
    updateShowDiffButton()
    check(btn.disabled === true && btn.title.includes('暂无变更明细'), '无缓存明细 → 按钮禁用并提示「暂无变更明细」')
    hideSyncDiffPanel()
    check(btn.disabled === true, 'hideSyncDiffPanel 无面板元素时安全跳过（仅刷新按钮态）')
  } finally {
    delete globalThis.document
  }
}

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
