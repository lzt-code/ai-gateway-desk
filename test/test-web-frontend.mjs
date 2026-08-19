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
check(viewButtons.length === 4, '含 4 个 data-view 按钮契约（providers/models/workers/account）')
check(
  JSON.stringify(viewButtons) === JSON.stringify(['providers', 'models', 'workers', 'account']),
  'data-view 顺序与 VIEW_ORDER 一致',
)

for (const v of ['providers', 'models', 'workers', 'account']) {
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
} = mod
check(true, 'app.js 可被 Node import（顶层无 DOM 访问，能加载即证明）')

// 8a：底部处理过程日志栏纯函数（logActivity / clearActivityLog）
check(typeof logActivity === 'function', 'logActivity 已导出（底部处理过程日志栏）')
check(typeof clearActivityLog === 'function', 'clearActivityLog 已导出')
check(logActivity('测试日志') === false, 'logActivity 无 DOM 环境返回 false（顶层零 DOM 访问）')

// 8：VIEWS / VIEW_ORDER / VIEW_LABELS
check(
  Object.keys(VIEWS).length === 4 && Object.values(VIEWS).every((v) => VIEW_ORDER.includes(v)),
  'VIEWS 四视图常量且均含于 VIEW_ORDER',
)
check(
  VIEW_ORDER.length === 4 &&
    ['providers', 'models', 'workers', 'account'].every((v) => VIEW_ORDER.includes(v)),
  'VIEW_ORDER 长度 4 且含全部 4 个视图名',
)
check(
  VIEW_LABELS.providers === 'Provider' &&
    VIEW_LABELS.models === '模型' &&
    VIEW_LABELS.workers === 'Worker' &&
    VIEW_LABELS.account === '账户',
  'VIEW_LABELS 文案（含 模型）',
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

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
