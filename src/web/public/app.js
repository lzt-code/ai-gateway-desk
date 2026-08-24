/**
 * 任务 30：前端页面骨架逻辑（API 客户端 + 选项卡切换 + 渲染分派 + 弹窗 + flash）
 *
 * 设计约束（交付包 §2/§3，任务 31-33 的前端依赖，改动需同步交付包）：
 * - 模块顶层零 DOM 访问：Node 测试可直接 import 纯函数；
 * - 启动由 start() 完成，顶部用 `typeof document !== 'undefined'` 守卫；
 * - 弹窗基于原生 <dialog>，Promise API（showDialog 等）；
 * - 视图切换 = 改 hidden；首次切换时懒渲染（renderView），切走不销毁 DOM（保留滚动/输入）；
 * - 选项卡 data-view 与视图容器 view-<name> 的 id 是任务 31-33 的绑定契约。
 */

// ── 视图定义（与 TUI keys.js 四视图对应）────────────────────
export const VIEWS = {
  PROVIDERS: 'providers',  // 选项卡 1：Provider
  MODELS: 'models',        // 选项卡 2：模型
  WORKERS: 'workers',      // 选项卡 3：Worker
  ACCOUNT: 'account',      // 选项卡 4：账户
}

// 视图顺序 + 选项卡文案（纯数据）
export const VIEW_ORDER = ['providers', 'models', 'workers', 'account']
export const VIEW_LABELS = {
  providers: 'Provider',
  models: '模型',
  workers: 'Worker',
  account: '账户',
}

// 每视图的提示栏文案（右侧提示栏按当前视图切换显示，任务 31-33 可扩展）
export const VIEW_HINTS = {
  providers: '云端合并展示 Provider；「隐藏」开关会同步 KV，跨 PC 生效',
  models: 'Provider 侧栏 + 模型表格；space 切换选中/隐藏；同步后保存并部署',
  workers: 'Worker 代码无需修改，此视图仅管理部署',
  account: '管理 API Token 与 Gateway Token（cfut_xxx）双槽位管理',
}

// 方案 1：首次切到模型页自动同步 — 会话级一次性标记（模块级，页面刷新重置）
let _modelsAutoSyncDone = false

// ── 全局状态 ───────────────────────────────────────────────
// 返回 { currentView, setView, get, set, data }；纯内存对象，无 DOM 依赖。
export function createState(initial = {}) {
  const data = { ...initial }
  let currentView = initial.currentView ?? null
  return {
    get currentView() {
      return currentView
    },
    setView(name) {
      if (VIEW_ORDER.includes(name)) currentView = name
    },
    get(key) {
      return data[key]
    },
    set(key, value) {
      data[key] = value
    },
    data,
  }
}

// ── API 客户端 ─────────────────────────────────────────────
// 统一请求：自动 JSON 序列化 + content-type + 错误归一
//  - 2xx → 返回 parsed JSON（204 → null）
//  - 非 2xx → 抛 ApiError(message, status)，message 取后端 body.error（无则 HTTP 状态文本）
//  - 网络失败 → 抛 ApiError('网络请求失败', 0)
//  - body 为 undefined 时 GET 不发 body
export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function api(url, { method = 'GET', body, signal } = {}) {
  const headers = {}
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(url, { method, headers, body: payload, signal })
  } catch (err) {
    // 调用方通过 signal 主动中止（拉取超时）→ 归一到可读文案；其余为网络失败
    if (err && err.name === 'AbortError') throw new ApiError('请求超时', 0)
    throw new ApiError('网络请求失败', 0)
  }
  if (res.ok) {
    if (res.status === 204) return null
    try {
      return await res.json()
    } catch {
      return null // 2xx 但无 JSON 体（如空响应）
    }
  }
  let message = ''
  try {
    const data = await res.json()
    if (data && typeof data.error === 'string' && data.error) message = data.error
  } catch {
    // 非 JSON 错误体：用 HTTP 状态文本兜底
  }
  if (!message) message = `HTTP ${res.status} ${res.statusText}`.trim()
  throw new ApiError(message, res.status)
}

// ── 弹窗（原生 <dialog> + Promise API）──────────────────────
// showDialog({ title, body, actions }) → Promise<action id | null>
//  - body 可为 HTML 字符串或 DOM 节点
//  - actions: [{ id, label, variant?: 'primary'|'danger'|'default' }]
//  - resolve(action.id)（点按钮）/ resolve(null)（Esc / 点击遮罩）
export function showDialog({ title, body, actions = [] }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    const prevActive = document.activeElement

    const header = document.createElement('div')
    header.className = 'dialog-header'
    header.textContent = title

    const bodyEl = document.createElement('div')
    bodyEl.className = 'dialog-body'
    if (typeof body === 'string') {
      bodyEl.innerHTML = body
    } else if (body instanceof Node) {
      bodyEl.appendChild(body)
    }

    const actionsEl = document.createElement('div')
    actionsEl.className = 'dialog-actions'
    const list = actions.length ? actions : [{ id: 'close', label: '关闭' }]
    for (const [i, a] of list.entries()) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-' + (a.variant || 'default')
      btn.textContent = a.label
      if (i === 0) btn.autofocus = true // 默认聚焦第一个按钮（已知坑 4）
      btn.addEventListener('click', () => dialog.close(a.id))
      actionsEl.appendChild(btn)
    }

    dialog.appendChild(header)
    dialog.appendChild(bodyEl)
    dialog.appendChild(actionsEl)

    // 点击遮罩关闭（原生 dialog 的 ::backdrop 点击事件 target 即 dialog 自身）
    dialog.addEventListener('click', (e) => {
      const r = dialog.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        dialog.close()
      }
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      // 关闭后焦点回到触发元素（已知坑 4）
      if (prevActive && typeof prevActive.focus === 'function' && document.contains(prevActive)) {
        prevActive.focus()
      }
      resolve(dialog.returnValue || null)
    })

    document.body.appendChild(dialog)
    dialog.showModal()
  })
}

// 快捷确认（ok/cancel）→ Promise<boolean>
export function confirmDialog(title, message, { danger = false } = {}) {
  return showDialog({
    title,
    body: message,
    actions: [
      { id: 'ok', label: '确定', variant: danger ? 'danger' : 'primary' },
      { id: 'cancel', label: '取消', variant: 'default' },
    ],
  }).then((r) => r === 'ok')
}

// select 字段选项归一化（纯函数，可单测）：
//  - 字符串数组 ['a','b'] → [{ value:'a', label:'a' }, { value:'b', label:'b' }]（value===label）
//  - 对象数组 [{ value, label }] → 原样规范化输出 [{ value, label }]（label 保留）
//  - 混合数组中的非法项（null、数字、缺 value 的对象等）→ 过滤
//  - undefined / 非数组 → []
export function normalizeSelectOptions(options) {
  if (!Array.isArray(options)) return []
  const out = []
  for (const item of options) {
    if (typeof item === 'string') {
      out.push({ value: item, label: item })
    } else if (item && typeof item === 'object' && item.value != null) {
      out.push({ value: item.value, label: item.label != null ? item.label : item.value })
    }
  }
  return out
}

// 表单弹窗：fields: [{ name, label, type, value, placeholder?, disabled?, options? }] → Promise<object|null>（取消 → null）
// 任务 32 扩展（向后兼容，原 text/password 不变，交付包 §2 决策 3 / 已知坑 1）：
//  - type: 'checkbox'  → checkbox 渲染，值用 f.value 初始化 checked；收集时返回 .checked（boolean）
//  - type: 'readonly'  → 只读文本展示（灰色，非输入框）；收集时返回原值（slug 不参与提交，已知坑 6）
//  - type: 'select'    → <select> 下拉框，选项来自 normalizeSelectOptions(f.options)（字符串数组
//                        自动转 {value,label}），f.value 匹配项 selected，f.disabled 透传
//  - f.disabled        → 云端字段在只读模式下禁用（本地开关除外，§3.1 step 4）
//  - f.placeholder     → 透传给输入框（api key「输入新 key 覆盖，留空不修改」）
//  - f.hint            → 可选，输入框下方的提示文案（如 base URL 的 /v1 说明）
export function promptDialog(title, fields) {
  const bodyEl = document.createElement('div')
  for (const f of fields || []) {
    const label = document.createElement('label')
    if (f.type === 'switch') {
      // 开关按钮：标题在左、开关在右（flex 两端对齐），点击切换；disabled 时不可点。
      // 不用原生 checkbox：全局 input 样式（width:100% + margin-top）会破坏行内对齐。
      const row = document.createElement('div')
      row.className = 'switch-row'
      const text = document.createElement('span')
      text.className = 'switch-label'
      text.textContent = f.label || f.name
      const sw = document.createElement('button')
      sw.type = 'button'
      sw.className = 'switch'
      sw.dataset.field = f.name
      sw.setAttribute('role', 'switch')
      sw.setAttribute('aria-checked', f.value ? 'true' : 'false')
      if (f.disabled) sw.disabled = true
      const track = document.createElement('span')
      track.className = 'switch-track'
      const thumb = document.createElement('span')
      thumb.className = 'switch-thumb'
      track.appendChild(thumb)
      sw.appendChild(track)
      sw.addEventListener('click', () => {
        const on = sw.getAttribute('aria-checked') === 'true'
        sw.setAttribute('aria-checked', String(!on))
      })
      row.append(text, sw)
      label.appendChild(row)
    } else if (f.type === 'checkbox') {
      // checkbox 惯例：勾选框在文案左侧
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.name = f.name
      input.checked = !!f.value
      if (f.disabled) input.disabled = true
      input.dataset.field = f.name
      const text = document.createElement('span')
      text.textContent = f.label || f.name
      label.append(input, text)
    } else if (f.type === 'readonly') {
      // 只读展示：非输入框，灰色（slug 语义，已知坑 6）
      const div = document.createElement('div')
      div.className = 'field-readonly'
      div.dataset.field = f.name
      div.textContent = f.value != null ? String(f.value) : ''
      label.append(document.createTextNode(f.label || f.name), div)
    } else if (f.type === 'select') {
      // 下拉选择：选项来自 normalizeSelectOptions(f.options)（字符串数组自动转
      // {value,label}），f.value 匹配项 selected，f.disabled 透传；label 文案与 text 分支同款
      const select = document.createElement('select')
      select.name = f.name
      select.dataset.field = f.name
      if (f.disabled) select.disabled = true
      const current = f.value != null ? String(f.value) : ''
      for (const opt of normalizeSelectOptions(f.options)) {
        const option = document.createElement('option')
        option.value = opt.value
        option.textContent = opt.label
        if (String(opt.value) === current) option.selected = true
        select.appendChild(option)
      }
      label.append(document.createTextNode(f.label || f.name), select)
      if (f.hint) {
        const hint = document.createElement('div')
        hint.className = 'field-hint'
        hint.textContent = f.hint
        label.appendChild(hint)
      }
    } else {
      const input = document.createElement('input')
      input.type = f.type || 'text'
      input.name = f.name
      input.value = f.value != null ? String(f.value) : ''
      input.dataset.field = f.name
      if (f.placeholder != null) input.placeholder = f.placeholder
      if (f.disabled) input.disabled = true
      label.append(document.createTextNode(f.label || f.name), input)
      if (f.hint) {
        const hint = document.createElement('div')
        hint.className = 'field-hint'
        hint.textContent = f.hint
        label.appendChild(hint)
      }
    }
    bodyEl.appendChild(label)
  }
  return showDialog({
    title,
    body: bodyEl,
    actions: [
      { id: 'ok', label: '确定', variant: 'primary' },
      { id: 'cancel', label: '取消', variant: 'default' },
    ],
  }).then((r) => {
    if (r !== 'ok') return null
    const values = {}
    for (const f of fields || []) {
      if (f.type === 'readonly') {
        // 只读字段返回原值（不参与提交；slug 永不上送）
        values[f.name] = f.value != null ? String(f.value) : ''
        continue
      }
      const el = bodyEl.querySelector(`[data-field="${f.name}"]`)
      if (!el) {
        values[f.name] = ''
        continue
      }
      // 已知坑 2：checkbox 收集 .checked（boolean）；switch 收集 aria-checked（boolean），不是 value 字符串
      if (f.type === 'switch') {
        values[f.name] = el.getAttribute('aria-checked') === 'true'
      } else {
        values[f.name] = f.type === 'checkbox' ? el.checked : el.value
      }
    }
    return values
  })
}

// ── flash 提示（toast，3s 自动消失）────────────────────────
export function flash(message, type = 'info') {
  if (typeof document === 'undefined') return
  const root = document.getElementById('flash-root')
  if (!root) return
  // 连续 flash：旧 toast 先移除再插入，避免堆积（已知坑 6）
  while (root.firstChild) root.removeChild(root.firstChild)
  const el = document.createElement('div')
  el.className = 'flash flash-' + type
  el.textContent = message
  root.appendChild(el)
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el)
  }, 3000)
}

// ── 全局加载指示（转圈圈）────────────────────────────────
// 所有异步操作（进入视图拉列表 / 保存部署 / 同步 KV / 部署 Worker / 刷新状态等）
// 统一通过页头右侧的 #busy-indicator 胶囊提示「正在工作」。
// 实现用引用计数：并发/嵌套操作共享同一个指示器，全部结束才隐藏（避免闪烁），
// 文案取最近一次 showBusy 的 message（计数归零后不再更新）。
// 纯函数约束：Node 无 DOM 环境只维护计数不碰 DOM（顶层零 DOM 访问的前提）。
let busyCount = 0
let busyText = ''

function renderBusyIndicator() {
  if (typeof document === 'undefined') return
  const el = document.getElementById('busy-indicator')
  if (!el) return
  el.hidden = busyCount === 0
  if (busyCount > 0) {
    const text = document.getElementById('busy-text')
    if (text) text.textContent = busyText
  }
}

// 显示加载指示（可叠加：每调一次 showBusy，需对应一次 hideBusy 才会隐藏）
export function showBusy(message) {
  busyCount += 1
  busyText = message || '处理中…'
  renderBusyIndicator()
}

// 隐藏加载指示（引用计数递减，全部并发操作结束才真正隐藏）
export function hideBusy() {
  busyCount = Math.max(0, busyCount - 1)
  renderBusyIndicator()
}

// 便捷包装：work 为 Promise 或 ()=>Promise。期间显示指示器，结束（含异常）
// 自动隐藏——用 try/finally 保证 hideBusy 必被调用，无需调用方自行配对。
export async function withBusy(message, work) {
  showBusy(message)
  try {
    return await (typeof work === 'function' ? work() : work)
  } finally {
    hideBusy()
  }
}

// ── 复制文本到剪贴板（模型名称复制按钮用）──────────────────
// 返回 Promise<boolean>：true=成功；false=失败（无 Clipboard API / 无 DOM /
// 权限拒绝）。失败时调用方应给出可见提示。
// 纯函数约束：Node 无 DOM 环境安全返回 false。
export async function copyToClipboard(text) {
  if (typeof document === 'undefined' || !text) return false
  // 优先 Clipboard API（HTTPS / localhost 可用；页面在本地 http 下也常可用）
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(String(text))
      return true
    } catch {
      // 权限拒绝等 → 走 execCommand 兜底
    }
  }
  // 兜底：隐藏 textarea + document.execCommand('copy')（旧浏览器 / 非安全上下文）
  try {
    const ta = document.createElement('textarea')
    ta.value = String(text)
    ta.setAttribute('readonly', '')
    ta.style.position = 'absolute'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ── 底部处理过程日志栏（全局，所有操作写入）────────────────
// 所有视图的操作（拉取 Provider / 更新模型列表 / 获取 Worker 状态 / 更新模型信息 /
// 保存部署 / 账户操作等）统一追加一行带时间戳的日志；最多保留 200 行，自动滚动到底部。
// 纯函数约束：Node 无 DOM 环境安全返回 false（顶层零 DOM 访问），type 取值
// 'info' | 'ok' | 'warn' | 'err'，对应 .log-* 颜色类。
export function logActivity(text, type = 'info') {
  if (typeof document === 'undefined') return false
  const body = document.getElementById('activity-log-body')
  if (!body) return false
  const empty = body.querySelector(':scope > .log-empty')
  if (empty) empty.remove()
  const line = document.createElement('div')
  line.className = 'log-line log-' + type
  line.textContent = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`
  body.appendChild(line)
  while (body.children.length > 200) body.removeChild(body.firstChild)
  body.scrollTop = body.scrollHeight
  updateLogCount()
  return true
}

// 清空日志栏（恢复空状态占位，同步更新计数）
export function clearActivityLog() {
  if (typeof document === 'undefined') return
  const body = document.getElementById('activity-log-body')
  if (!body) return
  body.innerHTML = ''
  const empty = document.createElement('div')
  empty.className = 'log-empty'
  empty.textContent = '暂无操作记录'
  body.appendChild(empty)
  updateLogCount()
}

// 日志行数计数 badge（0 → hidden）
function updateLogCount() {
  if (typeof document === 'undefined') return
  const countEl = document.getElementById('log-count')
  if (!countEl) return
  const count = document.querySelectorAll('#activity-log-body .log-line').length
  countEl.hidden = count === 0
  countEl.textContent = count > 0 ? `${count}` : ''
}

// 日志栏按钮绑定（清空 / 三态切换）；start() 时调用一次
// 三态：compact（默认 4 行）→ expanded（32vh）→ collapsed（隐藏）→ compact
function initActivityLog() {
  if (typeof document === 'undefined') return
  const root = document.getElementById('activity-log')
  if (!root) return
  const btnClear = document.getElementById('btn-log-clear')
  if (btnClear) {
    btnClear.addEventListener('click', () => clearActivityLog())
  }
  const btnToggle = document.getElementById('btn-log-toggle')
  if (btnToggle) {
    btnToggle.addEventListener('click', () => {
      if (root.classList.contains('collapsed')) {
        // collapsed → compact
        root.classList.remove('collapsed')
        btnToggle.textContent = '展开全部'
      } else if (root.classList.contains('expanded')) {
        // expanded → collapsed
        root.classList.remove('expanded')
        root.classList.add('collapsed')
        btnToggle.textContent = '展开'
      } else {
        // compact → expanded
        root.classList.add('expanded')
        btnToggle.textContent = '收起'
      }
    })
  }
}

// ── 渲染分派 + 切换 ────────────────────────────────────────
const _renderers = new Map() // view → fn(container)
const _rendered = new Set()  // 已渲染视图（懒渲染：首次切换时渲染，切走不销毁 DOM）
let _state = null            // 模块级单例状态（start/switchView 使用）

export function registerViewRenderer(view, fn) {
  _renderers.set(view, fn)
}

// 渲染指定视图：首次懒渲染（调用注册的渲染函数），之后仅切换显隐/高亮/提示栏。
// Node 无 DOM 环境：仍执行懒渲染分派（便于单测），DOM 操作全部跳过。
export function renderView(name) {
  if (!VIEW_ORDER.includes(name)) return
  if (!_rendered.has(name)) {
    const fn = _renderers.get(name)
    if (typeof fn === 'function') {
      fn(typeof document === 'undefined' ? undefined : document.getElementById('view-' + name))
    }
    _rendered.add(name)
  }
  if (typeof document === 'undefined') return
  // 显隐切换
  for (const v of VIEW_ORDER) {
    const el = document.getElementById('view-' + v)
    if (el) el.hidden = v !== name
  }
  // 选项卡高亮
  for (const btn of document.querySelectorAll('#tab-bar [data-view]')) {
    btn.classList.toggle('active', btn.dataset.view === name)
  }
  // 提示栏文案：无文案时隐藏整个提示框
  const hint = document.getElementById('hint-bar')
  if (hint) {
    const text = VIEW_HINTS[name] || ''
    hint.textContent = text
    hint.hidden = !text
  }
  // 模型视图：固定视口高度链，让左/中/右三栏各自独立滚动（小屏由 CSS 回退整页滚动）
  document.body.classList.toggle('models-active', name === 'models')
  const sideActions = document.getElementById('side-actions')
  if (sideActions) sideActions.hidden = name !== 'providers'
  const modelSideActions = document.getElementById('model-side-actions')
  if (modelSideActions) modelSideActions.hidden = name !== 'models'
}

function appState() {
  if (!_state) _state = createState()
  return _state
}

// 切换视图：更新当前视图并渲染；重复切换同一视图幂等（不重复渲染）。
export function switchView(name) {
  const s = appState()
  if (!VIEW_ORDER.includes(name)) return s
  if (s.currentView === name) return s
  s.setView(name)
  renderView(name)
  return s
}

// 默认占位渲染器（任务 31-33 用 registerViewRenderer 覆盖各视图）
for (const name of VIEW_ORDER) {
  registerViewRenderer(name, (container) => {
    if (!container) return
    container.innerHTML = ''
    const h2 = document.createElement('h2')
    h2.className = 'view-title'
    h2.textContent = VIEW_LABELS[name]
    const p = document.createElement('p')
    p.className = 'view-hint'
    p.textContent = VIEW_HINTS[name]
    container.append(h2, p)
  })
}

// 启动：绑定选项卡事件委托 + 渲染默认视图（DOMContentLoaded 触发）
export function start() {
  if (typeof document === 'undefined') return
  const go = () => {
    initActivityLog() // 底部处理过程日志栏（清空 / 收起展开按钮）
    const bar = document.getElementById('tab-bar')
    if (bar) {
      bar.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-view]') : null
        if (btn && btn.dataset.view) switchView(btn.dataset.view)
      })
    }
    switchView(VIEW_ORDER[0])
  }
  // 已知坑 3：module 默认 defer，DOM 已就绪；readyState 判断兜底
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', go)
  } else {
    go()
  }
}

// ── 表格列排序（模型 / Provider 视图共用纯函数）─────────────────
// 交互约定：点击表头三态循环 未排序 → 升序 → 降序 → 未排序；
// 排序在渲染前做（sortViewItems 返回新数组），不改内存数据顺序。

// 值比较：数值按大小；数组逐元素；其余转字符串 localeCompare（数字感知 + 忽略大小写）
function cmpSortValues(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const av = a[i] == null ? -1 : a[i]
      const bv = b[i] == null ? -1 : b[i]
      const r = cmpSortValues(av, bv)
      if (r !== 0) return r
    }
    return 0
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

// 按 getter 取值排序（稳定排序，返回新数组不修改原数组）；dir：asc|desc
export function sortViewItems(items, getValue, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1
  return [...(items || [])].sort((x, y) => cmpSortValues(getValue(x), getValue(y)) * sign)
}

// 点击表头后的排序状态流转：换列 → asc；同列 asc → desc；同列 desc → 清除
export function nextSortState(key, dir, clickedKey) {
  if (key !== clickedKey || key === null) return { key: clickedKey, dir: 'asc' }
  if (dir === 'asc') return { key: clickedKey, dir: 'desc' }
  return { key: null, dir: 'asc' }
}

// 长度字段 → 可比较数值（值可能为字符串，缺失/非法 → -1 排在前）
const sortLengthValue = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : -1
}

// Provider 列取值器（th[data-sort] 键 → 排序值）
// visibility：启用(0) 在 隐藏(1) 前；mark：无标记(0) → 新增(1) → 云端已删(2)
export const PROVIDER_SORT_GETTERS = {
  slug: (p) => String(p && p.id) || '',
  name: (p) => String(p && p.name != null ? p.name : ''),
  type: (p) => String(p && p.type) || '',
  visibility: (p) => (p && p.enabled === false ? 1 : 0),
  mark: (p) => (p && p.mark === 'new' ? 1 : p && p.mark === 'removed' ? 2 : 0),
}

// 模型状态排序位次（与 TUI 分组一致：selected > hidden > removed）
const MODEL_STATUS_RANK = { selected: 0, hidden: 1, removed: 2 }

// 模型列取值器（th[data-sort] 键 → 排序值）；context 先按上下文再按输出长度
export const MODEL_SORT_GETTERS = {
  name: (it) => String((it && it.entry && it.entry.metadata && it.entry.metadata.name)
    || String(it && it.modelId).split('/').pop() || ''),
  modelId: (it) => String(it && it.modelId) || '',
  context: (it) => [
    sortLengthValue(it && it.entry && it.entry.metadata && it.entry.metadata.context_length),
    sortLengthValue(it && it.entry && it.entry.metadata && it.entry.metadata.max_output_length),
  ],
  status: (it) => (it && it.entry && MODEL_STATUS_RANK[it.entry.status]) ?? 3,
}

// ── 任务 31：前端模型管理视图（纯函数 + 渲染器）─────────────────
// 数据流（交付包 §2 决策）：进入视图拉一次 /api/state + /api/providers/list 到内存；
// 变更操作走 POST 端点并用响应更新内存态，再重新 applyFilter（不整页刷新）。

// 状态图标：selected→◉(ok) / hidden→○(warn) / removed→✕(err)
const STATUS_MAP = {
  selected: { icon: '◉', text: '选中', cls: 'ok' },
  hidden: { icon: '○', text: '隐藏', cls: 'warn' },
  removed: { icon: '✕', text: '移除', cls: 'err' },
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 长度紧凑格式化（已知坑 9：值可能为字符串，NaN → 空串）
// 进制自适应：数值能被 1000 整除按 1000 进（如 128000 → 128K），否则按 1024 进（如 131072 → 128K）
function formatCompactLength(v) {
  if (v === undefined || v === null || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return ''
  const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '')
  const base = n % 1000 === 0 ? 1000 : 1024
  if (n < base) return String(n)
  const k = n / base
  if (k < base) return `${trim(k)}K`
  return `${trim(k / base)}M`
}

// 上下文/输出长度合并单元格："64K/256K"；仅一侧缺失用 "-" 占位，双侧缺失为空串
function formatContextOutput(ctx, out) {
  const c = formatCompactLength(ctx)
  const o = formatCompactLength(out)
  if (!c && !o) return ''
  return `${c || '-'}/${o || '-'}`
}

// 模型数据（/api/models/filtered 的 items）→ 表格行 HTML 数组
// 列：模型名称 / 模型ID / 上下文/输出 / 状态（Provider 不单独成列：id 前缀已含归属，侧栏负责筛选）
// 返回 [{ modelId, html }]，html 为 <tr data-model-id="...">...</tr>
export function buildModelTableRows(items) {
  const rows = []
  for (const it of items || []) {
    if (!it || !it.modelId || !it.entry) continue
    const { modelId, entry } = it
    const meta = entry.metadata || {}
    const statusKey = STATUS_MAP[entry.status] ? entry.status : 'hidden'
    const st = STATUS_MAP[statusKey]
    const contextText = formatContextOutput(meta.context_length, meta.max_output_length)
    // 名称缺失时回退到 modelId 最后一段（如 openrouter/x-ai/grok-4.20 → grok-4.20）
    const modelName = meta.name || modelId.split('/').pop() || ''
    // 复制按钮复制完整 modelId（含 provider 前缀，如 custom-agnes/agnes-2.5-flash），可直接用于 agent 添加模型
    const html =
      `<tr data-model-id="${escapeHtml(modelId)}" class="row-${statusKey}">` +
      `<td><span class="model-name-text" title="${escapeHtml(modelName)}">${escapeHtml(modelName)}</span></td>` +
      `<td><span class="model-id-text">${escapeHtml(modelId)}</span>` +
      `<button class="model-copy" data-copy-model="${escapeHtml(modelId)}" title="复制完整模型名称（含 Provider）" type="button">⧉</button></td>` +
      `<td>${contextText}</td>` +
      `<td><button class="status-toggle" data-model-id="${escapeHtml(modelId)}" title="切换状态" type="button"><span class="status-${st.cls}">${st.icon} ${st.text}</span></button></td>` +
      `</tr>`
    rows.push({ modelId, html })
  }
  return rows
}

// SSE 事件流文本 → 结构化事件数组（data 已 JSON.parse；坏 data → null 不抛错）
// 格式：event: <type>\ndata: <json>\n\n（块间空行分隔）
export function parseSSEEvents(text) {
  if (typeof text !== 'string' || !text) return []
  const events = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = null
    let data = null
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        const val = line.slice(5)
        // SSE 规范：首行 data 值去掉一个前导空格；多行 data 以 \n 连接（本协议均为单行）
        data = data === null ? val.replace(/^ /, '') : data + '\n' + val
      }
    }
    if (event === null && data === null) continue // 空块（如结尾换行）
    let parsed = null
    if (data !== null) {
      try {
        parsed = JSON.parse(data)
      } catch {
        parsed = null
      }
    }
    events.push({ event: event === null ? 'message' : event, data: parsed })
  }
  return events
}

// 事件数组 → 同步进度状态映射（含最终汇总）
// 返回 { providers: { [slug]: { status, models?, error? } }, phase, summary, error }
export function buildSyncProgressState(events) {
  const providers = {}
  let phase = null
  let summary = null
  let error = null
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data
    if (ev.event === 'phase' && data && typeof data.phase === 'string') {
      phase = data.phase
    } else if (ev.event === 'discover' && data && typeof data.provider === 'string') {
      const status = data.status === 'done' || data.status === 'error' ? data.status : 'pending'
      const rec = { status }
      if (status === 'done' && data.models != null) rec.models = data.models
      if (status === 'error' && data.error != null) rec.error = data.error
      providers[data.provider] = rec
    } else if (ev.event === 'done' && data && data.summary) {
      summary = data.summary
      phase = 'done'
    } else if (ev.event === 'error' && data && typeof data.message === 'string') {
      error = data.message
    }
  }
  return { providers, phase, summary, error }
}

// 筛选参数 → query 字符串（encodeURIComponent；空值省略）
export function filterQuery({ provider, keyword, status } = {}) {
  const parts = []
  if (provider) parts.push('provider=' + encodeURIComponent(provider))
  if (keyword) parts.push('keyword=' + encodeURIComponent(keyword))
  if (status) parts.push('status=' + encodeURIComponent(status))
  return parts.join('&')
}

// 键序无关的递归深比较（已知坑 5：JSON.stringify 键序敏感，测试 17 专门覆盖）
function deepEqual(a, b) {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

// dirty 判定：深度比较初始快照与当前状态（键序无关）
export function computeDirty(snapshot, current) {
  return !deepEqual(snapshot, current)
}

// 视图局部样式（style.css 不在本任务改动范围内，随视图注入一次）
function injectModelsStyles() {
  if (document.getElementById('models-view-styles')) return
  const style = document.createElement('style')
  style.id = 'models-view-styles'
  style.textContent = `
    /* 宽屏（≥901px，由 body.models-active 高度链支撑）：三栏占满 #view-models 高度，各自滚动。
       小屏：无 overflow，整页自然滚动（与原行为一致）。 */
    .models-layout {
      display: grid; grid-template-columns: 200px 1fr; gap: 1rem; margin-top: 0.75rem;
    }
    @media (min-width: 901px) {
      body.models-active .models-layout { flex: 1; min-height: 0; grid-template-rows: minmax(0, 1fr); }
      body.models-active .provider-sidebar {
        min-height: 0; overflow-y: auto;
      }
      body.models-active .models-main { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
      body.models-active .table-wrap { flex: 1; min-height: 0; overflow: auto; }
    }
    .provider-sidebar { display: flex; flex-direction: column; gap: 0.25rem; }
    .sidebar-item {
      background: transparent; color: var(--fg); border: 1px solid var(--border);
      border-radius: 6px; padding: 0.4rem 0.7rem; text-align: left; cursor: pointer;
      font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sidebar-item:hover { background: rgba(137, 180, 250, 0.14); }
    .sidebar-item.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .models-main { min-width: 0; display: flex; flex-direction: column; }
    .filter-bar { margin-bottom: 0.6rem; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .filter-status-group { display: flex; gap: 0.25rem; flex-shrink: 0; }
    .filter-status-btn {
      background: transparent; color: var(--fg); border: 1px solid var(--border);
      border-radius: 4px; padding: 0.2rem 0.5rem; font-size: 0.8rem; cursor: pointer;
      white-space: nowrap;
    }
    .filter-status-btn:hover { background: rgba(137, 180, 250, 0.14); }
    .filter-status-btn.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .table-wrap { overflow-x: auto; }
    /* 表头跟随中间列表滚动而固定（仅独立滚动模式需要；整页滚动时 sticky top 由顶部页头决定，故限定 body.models-active） */
    @media (min-width: 901px) {
      body.models-active .model-table thead th { position: sticky; top: 0; background: var(--panel); z-index: 1; }
    }
    .model-table { font-size: 0.8rem; }
    .model-table th, .model-table td { padding: 0.35rem 0.5rem; }
    /* 可排序表头：hover/激活态高亮，▲▼ 指示器小号显示 */
    .model-table th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    .model-table th.sortable:hover, .model-table th.sorted { color: var(--accent); }
    .model-table .sort-ind { margin-left: 0.25em; font-size: 0.7rem; }
    /* 模型名称：亮色主体，超长自动换行 */
    .model-name-text { word-break: break-word; }
    .model-table td:nth-child(2) { word-break: break-all; }
    .model-table th:nth-child(3), .model-table td:nth-child(3) { text-align: right; white-space: nowrap; }
    .model-table th:nth-child(4), .model-table td:nth-child(4) { white-space: nowrap; }
    .model-copy {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0 0.3rem; cursor: pointer; font-size: 0.8rem;
      line-height: 1.3; vertical-align: middle; font-family: inherit;
    }
    .model-copy:hover { background: rgba(137, 180, 250, 0.14); color: var(--accent); }
    .model-copy.copied { background: var(--accent); color: var(--bg); border-color: var(--accent); }
    .model-table tbody tr { cursor: pointer; }
    .model-table tbody tr.row-active { outline: 2px solid var(--accent); outline-offset: -2px; }
    .model-table tbody tr.row-removed { opacity: 0.6; }
    .status-ok { color: var(--ok); }
    .status-warn { color: var(--warn); }
    .status-err { color: var(--err); }
    .status-toggle {
      background: transparent; color: inherit; border: none;
      border-radius: 4px; padding: 0.15rem 0.4rem; cursor: pointer; font-size: 0.85rem;
    }
    .status-toggle:hover { background: rgba(137, 180, 250, 0.14); }
    .btn-hint { display: block; font-size: 0.7rem; font-weight: 400; opacity: 0.7; margin-top: 0.15rem; }
    .side-group { display: flex; flex-direction: column; gap: 0.4rem; }
    .side-group + .side-group { margin-top: 0.25rem; padding-top: 0.5rem; border-top: 1px solid var(--border); }
    .side-group-title { font-size: 0.75rem; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.15rem; }
    .empty-hint { padding: 1.5rem; text-align: center; color: var(--muted); font-size: 0.9rem; }
    .dirty-mark { color: var(--warn); font-size: 0.85rem; font-weight: 400; }
    .progress-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .progress-title { font-size: 0.85rem; }
    .progress-body { margin-top: 0.35rem; max-height: 20vh; overflow-y: auto; }
    .progress-line { font-size: 0.85rem; padding: 0.1rem 0; }
    .progress-close {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 0 0.4rem; cursor: pointer; font-size: 0.9rem; line-height: 1.3;
    }
    .progress-close:hover { background: rgba(137, 180, 250, 0.14); color: var(--fg); }
    .p-ok { color: var(--ok); }
    .p-warn { color: var(--warn); }
    .p-err { color: var(--err); }
    @media (max-width: 900px) { .models-layout { grid-template-columns: 1fr; } }
  `
  document.head.appendChild(style)
}

// 模型视图渲染器（闭包持有视图局部状态；Node 无 DOM 时直接返回）
export function renderModelsView(container) {
  if (!container || typeof document === 'undefined') return
  if (container.dataset.modelsRendered) return // 幂等保护（renderView 已保证懒渲染一次）
  container.dataset.modelsRendered = '1'

  injectModelsStyles()

  // ── 视图局部状态 ────────────────────────────────────────
  let state = {}              // 内存态（/api/state 全集，只读来源，决策 10）
  let providers = []          // provider 列表（/api/providers/list，直接用作筛选参数）
  let snapshot = {}           // 进入视图时的初始快照（dirty 基准）
  let provider = null         // 侧栏筛选（null = 全部）
  let keyword = ''            // 关键字筛选（仅筛选条件，不标 dirty，已知坑 6）
  let status = null           // 状态筛选（null = 全部，selected/hidden/removed）
  let sortKey = null          // 列排序（th[data-sort]，null = 后端默认顺序）
  let sortDir = 'asc'         // 排序方向（asc/desc，sortKey=null 时无意义）
  let items = []              // 当前筛选结果
  let selectedModelId = null
  let syncing = false
  let finished = false        // 同步收尾标志（防 done/error/网络 error 重复处理）
  let es = null               // EventSource 实例
  let debounceTimer = null
  let progressDismissed = false // 用户手动收起后，本次同步后续事件不再弹出
  let autoHideTimer = null      // 全部成功后的自动隐藏定时器

  // ── DOM 骨架（§4.1 结构）────────────────────────────────
  container.innerHTML = ''
  container.innerHTML = `
    <h2 class="view-title">模型<span class="dirty-mark" hidden> * 未保存</span></h2>
    <div class="models-layout">
      <aside class="provider-sidebar"></aside>
      <div class="models-main">
        <div class="filter-bar">
          <div class="filter-status-group">
            <button class="filter-status-btn active" data-status="">全部</button>
            <button class="filter-status-btn" data-status="selected">✓ 选中</button>
            <button class="filter-status-btn" data-status="hidden">○ 隐藏</button>
            <button class="filter-status-btn" data-status="removed">✕ 已删除</button>
          </div>
          <input id="model-keyword" type="search" placeholder="关键字筛选（模型ID / 名称）…">
        </div>
        <div class="table-wrap" tabindex="-1">
          <table class="model-table">
            <thead><tr>
              <th class="sortable" data-sort="name" title="点击排序">模型名称<span class="sort-ind" hidden></span></th>
              <th class="sortable" data-sort="modelId" title="点击排序">模型ID<span class="sort-ind" hidden></span></th>
              <th class="sortable" data-sort="context" title="点击排序">上下文/输出<span class="sort-ind" hidden></span></th>
              <th class="sortable" data-sort="status" title="点击排序">状态<span class="sort-ind" hidden></span></th>
            </tr></thead>
            <tbody></tbody>
          </table>
          <div class="empty-hint" id="hint-no-match" hidden>无匹配模型</div>
          <div class="empty-hint" id="hint-no-provider" hidden>未配置 Provider，请到 Provider 视图查看</div>
        </div>
      </div>
    </div>
  `
  const sidebar = container.querySelector('.provider-sidebar')
  const keywordInput = container.querySelector('#model-keyword')
  const tbody = container.querySelector('.model-table tbody')
  const tableWrap = container.querySelector('.table-wrap')
  const hintNoMatch = container.querySelector('#hint-no-match')
  const hintNoProvider = container.querySelector('#hint-no-provider')
  const dirtyMark = container.querySelector('.dirty-mark')
  const btnSync = document.getElementById('mbtn-sync')
  const btnSaveDeploy = document.getElementById('mbtn-save-deploy')
  const btnSave = document.getElementById('mbtn-save')
  const btnBatchToggle = document.getElementById('mbtn-batch-toggle')
  const btnBatchRemove = document.getElementById('mbtn-batch-remove')
  const btnEdit = document.getElementById('mbtn-edit')
  const btnDelete = document.getElementById('mbtn-delete')
  const btnAdd = document.getElementById('mbtn-add')
  const progressPanel = document.getElementById('progress-panel')

  // ── 渲染辅助 ────────────────────────────────────────────
  function renderSidebar() {
    sidebar.innerHTML = ''
    const allBtn = document.createElement('button')
    allBtn.type = 'button'
    allBtn.className = 'sidebar-item' + (provider === null ? ' active' : '')
    allBtn.dataset.provider = ''
    allBtn.textContent = '全部'
    sidebar.appendChild(allBtn)
    for (const p of providers) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sidebar-item' + (provider === (typeof p === 'string' ? p : p.id) ? ' active' : '')
      btn.dataset.provider = typeof p === 'string' ? p : p.id
      const displayName = typeof p === 'string' ? p : (p.name && p.name !== 'default' ? p.name : p.id)
      btn.textContent = displayName
      sidebar.appendChild(btn)
    }
  }

  // 表头排序指示器（aria-sort + ▲/▼，随 sortKey/sortDir 同步）
  function updateSortIndicators() {
    for (const th of container.querySelectorAll('th[data-sort]')) {
      const active = th.dataset.sort === sortKey
      const ind = th.querySelector('.sort-ind')
      th.classList.toggle('sorted', active)
      th.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
      if (!ind) continue
      ind.hidden = !active
      ind.textContent = sortDir === 'asc' ? '▲' : '▼'
    }
  }

  function renderTable() {
    updateSortIndicators()
    const getter = sortKey ? MODEL_SORT_GETTERS[sortKey] : null
    const rows = buildModelTableRows(getter ? sortViewItems(items, getter, sortDir) : items)
    tbody.innerHTML = rows.map((r) => r.html).join('')
    for (const tr of tbody.querySelectorAll('tr')) {
      tr.classList.toggle('row-active', tr.dataset.modelId === selectedModelId)
    }
    // 空状态区分（已知坑 4）：未配置 Provider vs 无匹配模型
    const noProviders = providers.length === 0
    hintNoProvider.hidden = !noProviders
    hintNoMatch.hidden = noProviders || items.length > 0
  }

  function selectRow(modelId) {
    selectedModelId = modelId
    for (const tr of tbody.querySelectorAll('tr')) {
      tr.classList.toggle('row-active', tr.dataset.modelId === modelId)
    }
    tableWrap.focus({ preventScroll: true })
  }

  function updateDirty() {
    const dirty = computeDirty(snapshot, state)
    dirtyMark.hidden = !dirty
    appState().set('modelsDirty', dirty)
  }

  // 筛选：表格永远渲染「筛选结果」，内存 state 是全集（已知坑 4）
  async function applyFilter() {
    try {
      const q = filterQuery({ provider: provider || undefined, keyword: keyword || undefined, status: status || undefined })
      const url = '/api/models/filtered' + (q ? '?' + q : '')
      const res = await api(url)
      items = res.items || []
      renderTable()
    } catch (err) {
      flash(err.message, 'err')
    }
  }

  // ── 变更操作（响应驱动更新内存态，再重新 applyFilter）────
  async function toggleModel(modelId) {
    if (syncing) return
    try {
      const res = await withBusy('正在切换模型…', api('/api/models/toggle', { method: 'POST', body: { modelId } }))
      if (state[modelId]) state[modelId] = { ...state[modelId], ...(res.entry || {}) }
      updateDirty()
      await applyFilter()
      const st = res.entry && res.entry.status
      logActivity(`模型切换：${modelId} → ${st === 'selected' ? '选中' : st === 'hidden' ? '隐藏' : st || '未知'}`, 'info')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`模型切换失败：${modelId}（${err.message}）`, 'err')
    }
  }

  async function removeModel(modelId) {
    if (syncing) return
    const yes = await confirmDialog(
      '删除模型',
      `将永久删除「${modelId}」，是否继续？`,
      { danger: true },
    )
    if (!yes) return
    try {
      const res = await withBusy('正在删除模型…', api('/api/models/remove', { method: 'POST', body: { modelId } }))
      delete state[modelId] // 永久删除
      if (selectedModelId === modelId) selectedModelId = null
      updateDirty()
      await applyFilter()
      flash('已删除', 'ok')
      logActivity(`模型已删除：${modelId}`, 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`删除模型失败：${modelId}（${err.message}）`, 'err')
    }
  }

  async function batchToggle() {
    if (syncing) return
    const targets = items
      .filter((it) => it.entry && it.entry.status !== 'removed')
      .map((it) => it.modelId)
    if (!targets.length) {
      flash('当前筛选结果没有可切换的模型', 'warn')
      return
    }
    try {
      const res = await withBusy('正在批量切换…', api('/api/models/batch-toggle', { method: 'POST', body: { modelIds: targets } }))
      for (const id of targets) {
        if (state[id]) state[id].status = res.status
      }
      updateDirty()
      await applyFilter()
      logActivity(`批量切换：${targets.length} 个模型 → ${res.status === 'selected' ? '选中' : '隐藏'}`, 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`批量切换失败：${err.message}`, 'err')
    }
  }

  async function batchRemove() {
    if (syncing) return
    const targets = items
      .filter((it) => it.entry)
      .map((it) => it.modelId)
    if (!targets.length) {
      flash('当前筛选结果没有可删除的模型', 'warn')
      return
    }
    const yes = await confirmDialog(
      '批量删除模型',
      `将永久删除当前筛选出的 ${targets.length} 个模型，是否继续？`,
      { danger: true },
    )
    if (!yes) return
    try {
      const res = await withBusy('正在批量删除…', api('/api/models/batch-remove', { method: 'POST', body: { modelIds: targets } }))
      for (const id of targets) {
        delete state[id]
      }
      if (selectedModelId && targets.includes(selectedModelId)) selectedModelId = null
      updateDirty()
      await applyFilter()
      flash('已批量删除', 'ok')
      logActivity(`批量删除：${targets.length} 个模型`, 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`批量删除失败：${err.message}`, 'err')
    }
  }

  async function editModel() {
    if (syncing) return
    if (!selectedModelId) {
      flash('请先选中一行', 'warn')
      return
    }
    const meta = (state[selectedModelId] || {}).metadata || {}
    const values = await promptDialog(`编辑模型：${selectedModelId}`, [
      { name: 'name', label: '名称（留空不修改）', type: 'text', value: meta.name || '' },
      { name: 'context_length', label: '上下文长度（留空不修改）', type: 'text', value: meta.context_length != null ? String(meta.context_length) : '' },
      { name: 'max_output_length', label: '输出长度（留空不修改）', type: 'text', value: meta.max_output_length != null ? String(meta.max_output_length) : '' },
      { name: 'description', label: '描述（留空不修改）', type: 'text', value: meta.description || '' },
    ])
    if (!values) return
    // 已知坑 11：留空字段不发（省略键），不发空字符串
    const fields = {}
    if (String(values.name).trim() !== '') fields.name = String(values.name).trim()
    if (String(values.context_length).trim() !== '') {
      const n = Number(String(values.context_length).trim())
      if (!Number.isFinite(n)) {
        flash('上下文长度必须是数字', 'err')
        return
      }
      fields.context_length = n
    }
    if (String(values.max_output_length).trim() !== '') {
      const n = Number(String(values.max_output_length).trim())
      if (!Number.isFinite(n)) {
        flash('输出长度必须是数字', 'err')
        return
      }
      fields.max_output_length = n
    }
    if (String(values.description).trim() !== '') fields.description = String(values.description).trim()
    if (!Object.keys(fields).length) return
    try {
      const res = await withBusy('正在更新模型信息…', api('/api/models/edit', { method: 'POST', body: { modelId: selectedModelId, fields } }))
      if (state[selectedModelId]) {
        state[selectedModelId] = { ...state[selectedModelId], metadata: res.metadata || {} }
      }
      updateDirty()
      await applyFilter()
      flash('已保存修改', 'ok')
      logActivity(`更新模型信息：${selectedModelId}（${Object.keys(fields).join('、')}）`, 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`更新模型信息失败：${selectedModelId}（${err.message}）`, 'err')
    }
  }

  async function addModel() {
    if (syncing) return
    const bodyEl = document.createElement('div')
    const providerSelect = document.createElement('select')
    if (providers.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '（无已收集 Provider）'
      providerSelect.appendChild(opt)
    }
    for (const p of providers) {
      const opt = document.createElement('option')
      opt.value = p.id
      opt.textContent = p.name
      providerSelect.appendChild(opt)
    }
    const providerLabel = document.createElement('label')
    providerLabel.textContent = 'Provider（必填）'
    providerLabel.appendChild(providerSelect)
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.placeholder = '如 deepseek-v4-flash'
    const nameLabel = document.createElement('label')
    nameLabel.textContent = '模型名称（必填）'
    nameLabel.appendChild(nameInput)
    const ctxInput = document.createElement('input')
    ctxInput.type = 'text'
    const ctxLabel = document.createElement('label')
    ctxLabel.textContent = '上下文长度'
    ctxLabel.appendChild(ctxInput)
    const outInput = document.createElement('input')
    outInput.type = 'text'
    const outLabel = document.createElement('label')
    outLabel.textContent = '输出长度'
    outLabel.appendChild(outInput)
    const descInput = document.createElement('input')
    descInput.type = 'text'
    const descLabel = document.createElement('label')
    descLabel.textContent = '描述'
    descLabel.appendChild(descInput)
    bodyEl.append(providerLabel, nameLabel, ctxLabel, outLabel, descLabel)

    const r = await showDialog({
      title: '添加模型',
      body: bodyEl,
      actions: [
        { id: 'ok', label: '添加', variant: 'primary' },
        { id: 'cancel', label: '取消', variant: 'default' },
      ],
    })
    if (r !== 'ok') return
    const providerVal = providerSelect.value
    const modelName = nameInput.value.trim()
    if (!providerVal) {
      flash('Provider 必填', 'err')
      return
    }
    if (!modelName) {
      flash('模型名称 必填', 'err')
      return
    }
    const modelId = providerVal + '/' + modelName
    const metadata = {}
    if (nameInput.value.trim()) metadata.name = nameInput.value.trim()
    if (ctxInput.value.trim()) {
      const n = Number(ctxInput.value.trim())
      if (!Number.isFinite(n)) {
        flash('上下文长度必须是数字', 'err')
        return
      }
      metadata.context_length = n
    }
    if (outInput.value.trim()) {
      const n = Number(outInput.value.trim())
      if (!Number.isFinite(n)) {
        flash('输出长度必须是数字', 'err')
        return
      }
      metadata.max_output_length = n
    }
    if (descInput.value.trim()) metadata.description = descInput.value.trim()
    try {
      const res = await withBusy('正在添加模型…', api('/api/models/add', { method: 'POST', body: { modelId, provider: providerVal, metadata } }))
      state[modelId] = res.entry
      selectedModelId = modelId
      updateDirty()
      await applyFilter()
      flash('已添加模型', 'ok')
      logActivity(`添加模型：${modelId}（provider: ${providerVal}）`, 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`添加模型失败：${modelId}（${err.message}）`, 'err')
    }
  }

  async function saveModels(deploy) {
    logActivity(deploy ? '开始保存并提交部署…' : '开始保存（写 model-states + models.json）…', 'info')
    try {
      const res = await withBusy(deploy ? '正在保存并部署（同步 KV）…' : '正在保存…', api(deploy ? '/api/save-deploy' : '/api/save', { method: 'POST' }))
      if (!res || res.ok === false) {
        // 已知坑 10：save-deploy 业务失败用 HTTP 200 + { ok:false, step, error }；
        // step 3 = 部署失败（正常反馈），step 1/2 才是保存失败
        if (deploy && res && res.step === 3) {
          flash(`部署失败: ${res.error || '未知错误'}`, 'err')
          logActivity(`部署失败：${res.error || '未知错误'}`, 'err')
        } else {
          flash((res && res.error) || '保存失败', 'err')
          logActivity(`保存失败：${(res && res.error) || '未知错误'}`, 'err')
        }
        return
      }
      snapshot = structuredClone(state)
      updateDirty()
      logActivity(deploy ? '已保存并提交部署' : '已保存', 'ok')
      flash(deploy ? '已保存并提交部署' : '已保存', 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`保存失败：${err.message}`, 'err')
    }
  }

  // ── 同步（先订阅后触发，已知坑 2）────────────────────────
  function showProgress(initialTitle) {
    if (!progressPanel) return
    clearTimeout(autoHideTimer); autoHideTimer = null
    progressDismissed = false
    progressPanel.hidden = false
    progressPanel.innerHTML = ''
    progressPanel.appendChild(buildProgressHeader(initialTitle || '同步中…'))
  }

  // 头部：标题 + 关闭按钮（×）。关闭只隐藏面板，不中断同步；
  // 同步中的逐 Provider 明细在下方 .progress-body，结束后头部标题直接承载单行摘要。
  function buildProgressHeader(titleText) {
    const header = document.createElement('div')
    header.className = 'progress-header'
    const title = document.createElement('div')
    title.className = 'progress-title'
    title.textContent = titleText
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'progress-close'
    close.setAttribute('aria-label', '关闭同步进度')
    close.textContent = '×'
    close.addEventListener('click', dismissProgress)
    header.append(title, close)
    return header
  }

  function dismissProgress() {
    if (!progressPanel) return
    progressDismissed = true
    progressPanel.hidden = true
    if (autoHideTimer) { clearTimeout(autoHideTimer); autoHideTimer = null }
  }

  // 结束态自动收起：全部成功 5s；有失败/异常 8s（给足阅读时间后仍自动消失，避免一直遮挡）
  function scheduleAutoHide(ms = 5000) {
    clearTimeout(autoHideTimer)
    autoHideTimer = setTimeout(() => {
      autoHideTimer = null
      if (!progressDismissed) progressPanel.hidden = true
    }, ms)
  }

  function renderProgress(st) {
    if (!progressPanel) return
    if (progressDismissed) return // 用户已手动收起，本次同步不再弹出
    progressPanel.hidden = false

    const slugs = Object.keys(st.providers)
    const doneCount = slugs.filter((k) => st.providers[k].status === 'done').length
    const errCount = slugs.filter((k) => st.providers[k].status === 'error').length
    const isDone = st.phase === 'done'
    const isError = !!st.error

    // 标题：同步中显示进度；结束后承载单行摘要（明细交给底部日志栏，避免重复）
    let titleText
    if (isDone) {
      const s = st.summary || {}
      const parts = []
      if ((s.newModels || []).length) parts.push(`新增 ${s.newModels.length}`)
      if ((s.updatedModels || []).length) parts.push(`更新 ${s.updatedModels.length}`)
      if ((s.removedModels || []).length) parts.push(`移除 ${s.removedModels.length}`)
      titleText = `同步完成 ✓${doneCount}/${slugs.length}`
      if (parts.length) titleText += ` · ${parts.join(' / ')}`
      if (errCount > 0) titleText += ` · ✗${errCount} 失败`
    } else if (isError && slugs.length === 0) {
      titleText = `同步失败：${st.error}`
    } else if (isError) {
      titleText = '同步失败'
    } else {
      titleText = `同步中… ✓${doneCount}/${slugs.length}`
    }

    progressPanel.innerHTML = ''
    progressPanel.appendChild(buildProgressHeader(titleText))

    // 同步中列出全部 provider（实时进度）；结束态只列出失败/未完成项，
    // 成功明细已在底部日志栏完整记录，不再重复（解决两处内容重复问题）。
    const showDetail = !isDone || errCount > 0 || (isError && slugs.length > 0)
    if (showDetail) {
      const body = document.createElement('div')
      body.className = 'progress-body'
      const addLine = (cls, mark, text) => {
        const line = document.createElement('div')
        line.className = 'progress-line'
        const markEl = document.createElement('span')
        markEl.className = cls
        markEl.textContent = mark
        line.append(markEl, document.createTextNode(text))
        body.appendChild(line)
      }
      for (const slug of slugs) {
        const p = st.providers[slug]
        // 结束态跳过成功项（已由日志栏承载）；进行中全部展示
        if (isDone && p.status === 'done') continue
        if (p.status === 'done') {
          addLine('p-ok', '✓', ` ${slug}${p.models != null ? ` (${p.models})` : ''}`)
        } else if (p.status === 'error') {
          addLine('p-err', '✗', ` ${slug}${p.error ? ` ${p.error}` : ''}`)
        } else {
          addLine('p-warn', '⋯', ` ${slug}`)
        }
      }
      if (isError && slugs.length === 0) {
        addLine('p-err', '✗', ` ${st.error}`)
      }
      progressPanel.appendChild(body)
    }

    // 结束态：无论成功或部分失败均定时自动收起（失败给更长阅读时间）
    if (isDone) {
      const hasError = errCount > 0 || !!((st.summary && (st.summary.errors || []).length))
      scheduleAutoHide(hasError ? 8000 : 5000)
    } else if (isError) {
      scheduleAutoHide(8000)
    } else {
      clearTimeout(autoHideTimer)
      autoHideTimer = null
    }
  }

  function setSyncButtonsDisabled(v) {
    btnSync.disabled = v
    btnSaveDeploy.disabled = v
    btnSave.disabled = v
    btnBatchToggle.disabled = v
    btnBatchRemove.disabled = v
  }

  function finishSync() {
    if (finished) return
    finished = true
    if (es) {
      es.close()
      es = null
    }
    syncing = false
    appState().set('modelsSyncing', false)
    setSyncButtonsDisabled(false)
  }

  async function refreshAfterSync() {
    try {
      await withBusy('正在刷新模型列表…', async () => {
        const [s, p] = await Promise.all([api('/api/state'), api('/api/providers/list')])
        state = s.state || {}
        providers = p.providers || []
        renderSidebar()
        updateDirty() // 新模型进入内存态 → 相对初始快照 dirty（§6.e）
        await applyFilter()
      })
      flash('同步完成', 'ok')
    } catch (err) {
      flash(err.message, 'err')
    }
  }

  // 同步 SSE 事件 → 底部处理过程日志栏（阶段 / provider 同步 / 发现 / 富化 / 汇总）
  function logSyncEvent(evtName, data) {
    if (!data || typeof data !== 'object') return
    if (evtName === 'phase') {
      const names = { 'provider-sync': 'Provider 同步', discover: '发现模型', enrich: '合并与富化' }
      logActivity(`同步阶段：${names[data.phase] || data.phase}`, 'info')
    } else if (evtName === 'provider-sync') {
      if (data.skipped) {
        logActivity('Provider 同步跳过（未配置管理 Token）', 'warn')
      } else if (data.ok) {
        logActivity(`Provider 同步完成：${data.message || ''}`, 'ok')
        // 详细日志：逐条输出云端新增 / 移除的 provider，及各源失败（合并可能不完整）
        for (const id of data.newProviders || []) logActivity(`  新增 Provider：${id}`, 'ok')
        for (const id of data.removedProviders || []) logActivity(`  移除 Provider：${id}`, 'warn')
        for (const e of data.errors || []) {
          const srcName = e.source === 'custom-providers'
            ? 'Custom Providers'
            : e.source === 'provider_configs'
              ? 'BYOK provider_configs'
              : e.source || 'cloud'
          logActivity(`[${srcName}] 同步失败：${e.message || '未知错误'}（合并结果可能不完整）`, 'warn')
        }
      } else {
        logActivity(`Provider 同步失败：${data.message || '未知错误'}`, 'warn')
      }
    } else if (evtName === 'discover') {
      if (data.status === 'done') logActivity(`发现模型：${data.provider} 完成（${data.models} 个）`, 'ok')
      else if (data.status === 'error') logActivity(`发现模型：${data.provider} 失败：${data.error || '未知错误'}`, 'err')
      else logActivity(`发现模型：${data.provider} 进行中…`, 'info')
    } else if (evtName === 'enrich') {
      // 节流：每 10 条或最后一条记录，避免刷屏（同步中模型可能很多）
      if (data.enriched === data.total || data.enriched % 10 === 0) {
        logActivity(`富化模型：${data.enriched}/${data.total}`, 'info')
      }
    } else if (evtName === 'done') {
      const s = data.summary || {}
      const parts = []
      if ((s.newModels || []).length) parts.push(`新增 ${s.newModels.length}`)
      if ((s.updatedModels || []).length) parts.push(`更新 ${s.updatedModels.length}`)
      if ((s.removedModels || []).length) parts.push(`移除 ${s.removedModels.length}`)
      logActivity(`同步完成：${parts.join(' / ') || '无变化'}`, 'ok')
    } else if (evtName === 'error') {
      logActivity(`同步失败：${data.message || '未知错误'}`, 'err')
    }
  }

  function startSync() {
    if (syncing) return
    if (typeof EventSource === 'undefined') {
      flash('当前环境不支持 EventSource', 'err')
      return
    }
    syncing = true
    finished = false
    appState().set('modelsSyncing', true)
    setSyncButtonsDisabled(true)
    showProgress('同步中…')
    logActivity('开始同步（Provider 同步 → 发现模型 → 合并 → 富化）…', 'info')
    es = new EventSource('/api/sync/progress')
    const streamEvents = []
    const collect = (evtName) => (e) => {
      let data = null
      try {
        data = JSON.parse(e.data)
      } catch {
        // 坏 data：忽略该事件，不中断
      }
      streamEvents.push({ event: evtName, data })
      logSyncEvent(evtName, data)
      renderProgress(buildSyncProgressState(streamEvents))
    }
    es.addEventListener('phase', collect('phase'))
    es.addEventListener('provider-sync', collect('provider-sync'))
    es.addEventListener('discover', collect('discover'))
    es.addEventListener('enrich', collect('enrich'))
    es.addEventListener('done', (e) => {
      collect('done')(e)
      finishSync()
      refreshAfterSync()
    })
    es.addEventListener('error', (e) => {
      collect('error')(e)
      finishSync()
    })
    es.onopen = () => {
      // 先订阅后触发（任务 27 已知坑 1）：open 后再 POST，否则丢事件
      if (!es) return
      api('/api/sync', { method: 'POST' })
        .then(() => {
          // 结果由 SSE done 事件承载（summary 同源），POST 仅负责触发
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 409) {
            flash('同步已在进行', 'warn')
          } else {
            flash(err.message, 'err')
          }
          finishSync()
        })
    }
    es.onerror = () => {
      if (finished) return
      flash('同步连接中断', 'err')
      finishSync()
    }
  }

  // ── 事件绑定 ────────────────────────────────────────────
  sidebar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sidebar-item')
    if (!btn) return
    provider = btn.dataset.provider || null
    renderSidebar()
    applyFilter()
  })

  // 状态筛选按钮
  container.querySelector('.filter-status-group').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-status-btn')
    if (!btn) return
    status = btn.dataset.status || null
    for (const b of container.querySelectorAll('.filter-status-btn')) {
      b.classList.toggle('active', b === btn)
    }
    applyFilter()
  })

  // 表头点击排序：三态循环 未排序 → 升序 → 降序 → 未排序（纯前端，重渲染即可）
  container.querySelector('.model-table thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]')
    if (!th) return
    ;({ key: sortKey, dir: sortDir } = nextSortState(sortKey, sortDir, th.dataset.sort))
    renderTable()
  })

  keywordInput.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      keyword = keywordInput.value
      applyFilter()
    }, 300)
  })

  tbody.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.model-copy')
    if (copyBtn) {
      // 复制完整模型名称（含 provider 前缀），供 agent 添加模型使用
      const modelId = copyBtn.dataset.copyModel
      if (!modelId) return
      const btn = copyBtn
      btn.classList.add('copied')
      setTimeout(() => btn.classList.remove('copied'), 1200)
      copyToClipboard(modelId).then((ok) => {
        if (ok) {
          flash(`已复制：${modelId}`, 'ok')
          logActivity(`复制模型名称：${modelId}`, 'ok')
        } else {
          flash('复制失败，请手动选择复制', 'err')
        }
      })
      return
    }
    const statusBtn = e.target.closest('.status-toggle')
    if (statusBtn) {
      // 状态按钮：非 removed → toggle，removed → 永久删除（同右侧删除按钮）
      const modelId = statusBtn.dataset.modelId
      if (modelId) {
        if (state[modelId] && state[modelId].status === 'removed') {
          removeModel(modelId)
        } else {
          toggleModel(modelId)
        }
      }
      return
    }
    const tr = e.target.closest('tr[data-model-id]')
    if (tr) selectRow(tr.dataset.modelId)
  })

  // 空格键 toggle：只在表格容器处理，输入框/按钮聚焦时不拦截（已知坑 8）
  tableWrap.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) return
    if (!selectedModelId) return
    e.preventDefault()
    toggleModel(selectedModelId)
  })

  btnSync.addEventListener('click', startSync)
  btnSaveDeploy.addEventListener('click', () => saveModels(true))
  btnSave.addEventListener('click', () => saveModels(false))
  btnBatchToggle.addEventListener('click', batchToggle)
  btnBatchRemove.addEventListener('click', batchRemove)
  btnEdit.addEventListener('click', editModel)
  btnDelete.addEventListener('click', () => {
    if (!selectedModelId) {
      flash('请先选中一行', 'warn')
      return
    }
    removeModel(selectedModelId)
  })
  btnAdd.addEventListener('click', addModel)

  // 切走视图强制关闭 EventSource（已知坑 1 简单方案：切回不自动续，避免重复连接）
  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => {
      if (container.hidden) finishSync()
    })
    obs.observe(container, { attributes: true, attributeFilter: ['hidden'] })
  }

  // ── 初始加载：进入视图拉一次 /api/state + /api/providers/list（§3.1 step 2）──
  // 方案 1：本地数据先渲染（withBusy 内），完成后若为会话首次进入则探测
  // Gateway Token 就绪后静默触发 startSync（复用已有同步流程与进度面板）；
  // 未就绪/无 EventSource/探测失败均静默跳过，无弹窗打扰。
  ;(async () => {
    try {
      await withBusy('正在加载模型列表…', async () => {
        const [s, p] = await Promise.all([api('/api/state'), api('/api/providers/list')])
        state = s.state || {}
        providers = p.providers || []
        snapshot = structuredClone(state)
        renderSidebar()
        updateDirty()
        await applyFilter()
      })
    } catch (err) {
      flash(err.message, 'err')
      return
    }
    // 首次进入自动同步（会话级一次性；Token 未就绪则跳过，依赖面板内手动同步）
    if (_modelsAutoSyncDone) return
    if (typeof EventSource === 'undefined') {
      _modelsAutoSyncDone = true
      return
    }
    _modelsAutoSyncDone = true
    try {
      const r = await api('/api/sync/ready')
      if (r && r.ready) startSync()
    } catch {
      // 探测失败静默（不阻断本地已渲染的列表）
    }
  })()
}

// 注册模型视图渲染器（覆盖任务 30 的占位渲染器，分派契约）
registerViewRenderer('models', renderModelsView)

// ── 任务 32：前端 Provider 管理视图（纯函数 + 渲染器）─────────────────
// 数据流（交付包 §3.1）：进入视图拉一次 GET /api/providers 到内存（providers/readonly，
// readonly 是响应顶层字段，已知坑 4）；刷新按钮强制重拉（POST /api/providers/refresh，
// 语义同 GET，任务 28 决策 3）；变更操作走 POST 端点并用响应更新内存态再重渲染
// （不整页重拉，已知坑 5）。

// Provider 展示数组 → 表格行 HTML
// 列：slug（id）/ name / type（Custom|BYOK）/ 状态（启用|隐藏，本地可见性）/
//     mark（new→「新增」(ok) / removed→「云端已删」(err) / null→无）
// readonly=true → 编辑/删除按钮加 disabled；返回 [{ id, html }]
export function buildProviderTableRows(providers, readonly = false) {
  const rows = []
  for (const p of providers || []) {
    if (!p || !p.id) continue
    const isByok = p.type === 'byok'
    const typeText = isByok ? 'BYOK' : 'Custom'
    const statusText = p.enabled === false
      ? '<span class="status-hidden">隐藏</span>'
      : '<span class="status-ok">启用</span>'
    let markHtml = ''
    if (p.mark === 'new') markHtml = '<span class="status-ok">新增</span>'
    else if (p.mark === 'removed') markHtml = '<span class="status-err">云端已删</span>'
    const disabledAttr = readonly ? ' disabled' : ''
    const html =
      `<tr data-provider-id="${escapeHtml(p.id)}">` +
      `<td>${escapeHtml(p.id)}</td>` +
      `<td>${escapeHtml(p.name != null ? String(p.name) : '')}</td>` +
      `<td>${typeText}</td>` +
      `<td>${statusText}</td>` +
      `<td>${markHtml}</td>` +
      `<td><button class="btn-edit" type="button"${disabledAttr}>编辑</button> ` +
      `<button class="btn-delete" type="button"${disabledAttr}>删除</button></td>` +
      `</tr>`
    rows.push({ id: p.id, html })
  }
  return rows
}

// Base URL 输入框下方提示：Cloudflare 网关会自动拼接 /v1 路径，需去掉 /v1；
// 非 /v1 路径（如火山方舟 /api/v3）由「API 路径前缀」字段指定。添加/编辑共用。
const BASE_URL_HINT = 'Cloudflare 网关会自动拼接 /v1 路径，请填写去掉结尾 /v1 的 base URL；若上游 API 路径不是 /v1（如火山方舟 /api/v3），请用下方「API 路径前缀」字段指定。'

// provider → 编辑表单字段定义（供 promptDialog 扩展渲染）
// custom-provider：name + baseUrl + apiKey + pathPrefix + 隐藏开关 + slug(readonly)
// byok：name + apiKey(password) + 隐藏开关 + slug(readonly)
// readonly 模式下全部字段 disabled（可见性写 KV 需管理 Token）
export function buildEditFields(provider, { readonly = false } = {}) {
  const p = provider || {}
  const fields = [
    { name: 'name', label: '名称', type: 'text', value: p.name != null ? String(p.name) : '' },
  ]
  if (p.type === 'byok') {
    fields.push({
      name: 'apiKey', label: 'API Key', type: 'password', value: '',
      placeholder: '输入新 key 覆盖，留空不修改',
    })
  } else {
    // custom provider：Base URL + API Key + 路径前缀
    // 当前 base URL 从云端合并的 base_url（snake_case）读取；本地不落盘
    fields.push({
      name: 'baseUrl', label: 'Base URL', type: 'text',
      value: p.base_url != null ? String(p.base_url) : (p.baseUrl || ''),
      placeholder: 'https://…',
      hint: BASE_URL_HINT,
    })
    fields.push({
      name: 'apiKey', label: 'API Key', type: 'password', value: '',
      placeholder: '输入新 key 覆盖，留空不修改',
    })
    fields.push({
      name: 'pathPrefix', label: 'API 路径前缀', type: 'text',
      value: p.pathPrefix || '',
      placeholder: '如 /api/v3，留空使用默认 /v1',
    })
  }
  // 「隐藏」语义：开关打开 = 隐藏（enabled=false），不同步模型且模型页不展示
  fields.push({ name: 'hidden', label: '隐藏 Provider', type: 'switch', value: p.enabled === false })
  fields.push({ name: 'slug', label: 'slug（只读）', type: 'readonly', value: p.id || '' })
  if (readonly) {
    for (const f of fields) f.disabled = true
  }
  return fields
}

// 表单值 → 云端变更对象（null = 不修改，与后端 buildCloudUpdateParams 契约一致）
// 只收集「有变化的」字段；apiKey 留空 → apiKey: null；
// BYOK 改名且未填新 key → 返回 { blocked: 'BYOK 改名需要同时提供新 Key' }（前端拦截）
export function buildEditChanges(provider, values) {
  const p = provider || {}
  const v = values || {}
  const isByok = p.type === 'byok'
  const nameVal = typeof v.name === 'string' ? v.name.trim() : ''
  const apiKeyVal = typeof v.apiKey === 'string' ? v.apiKey.trim() : ''
  const baseUrlVal = typeof v.baseUrl === 'string' ? v.baseUrl.trim() : ''
  if (isByok && nameVal !== '' && nameVal !== p.name && apiKeyVal === '') {
    return { blocked: 'BYOK 改名需要同时提供新 Key' }
  }
  // BYOK 不支持 baseUrl（官方厂商路径固定），传入则拦截
  if (isByok && baseUrlVal !== '') {
    return { blocked: 'BYOK 不支持修改 Base URL' }
  }
  const name = nameVal !== '' && nameVal !== p.name ? nameVal : null
  const apiKey = apiKeyVal !== '' ? apiKeyVal : null
  // custom provider 的当前 base URL 从云端合并的 base_url（snake_case）读取
  const currentBaseUrl = p.base_url != null ? String(p.base_url) : (p.baseUrl || '')
  const baseUrl = !isByok && baseUrlVal !== '' && baseUrlVal !== currentBaseUrl ? baseUrlVal : null
  return { name, apiKey, baseUrl }
}

// 表单值 → 本地变更对象（可见性写本地 + KV，需管理 Token；null = 无变化不发）
export function buildLocalChanges(provider, values) {
  const p = provider || {}
  const v = values || {}
  const changes = {}
  // hidden 开关取反为 localEnabled（enabled=true 表示显示）
  if (v.hidden === true || v.hidden === false) {
    const nextEnabled = !v.hidden
    if (nextEnabled !== (p.enabled !== false)) changes.localEnabled = nextEnabled
  }
  // pathPrefix：空串视为清除，与现有值不同才发
  const pathVal = typeof v.pathPrefix === 'string' ? v.pathPrefix : ''
  const curPath = p.pathPrefix || ''
  if (pathVal !== curPath) {
    changes.pathPrefix = pathVal || '' // 空串 → 后端清除
  }
  return Object.keys(changes).length > 0 ? changes : null
}

// 拉取动作/结果 → 日志文案（纯函数，可单测）
// ok 为 undefined → 「开始拉取」行；否则为结果行：
//   ok=true + readonly → 只读降级（云端拉取失败/无管理 Token，展示本地缓存）
//   ok=true + !readonly → 云端合并成功（含数量）
//   ok=false → 失败（error 为 api() 归一后的可读文案，如「请求超时」）
export function buildProviderLogText({ force, ok, count, readonly, error } = {}) {
  if (ok === undefined) {
    return force ? '手动更新 Provider 列表…' : '进入视图自动拉取 Provider 列表…'
  }
  if (ok) {
    if (readonly) return '拉取完成：只读降级，展示本地缓存'
    return `拉取完成：云端合并 ${count} 个 Provider`
  }
  return `拉取失败：${error || '未知错误'}`
}

// 单条 provider → 详细日志行（纯函数，可单测）
// 可见性统一按本地 enabled 显示「启用/隐藏」（不再区分云端/本地）。
// mark：new → 「（云端新增）」；removed → 「（云端已删）」（仅云端合并模式有值）
function buildProviderLogLine(p, cloudMode) {
  const typeText = p.type === 'byok' ? 'BYOK' : 'Custom'
  const nameText = p.name != null && String(p.name) !== p.id ? `「${p.name}」` : ''
  let markText = ''
  if (cloudMode && p.mark === 'new') markText = '（云端新增）'
  else if (cloudMode && p.mark === 'removed') markText = '（云端已删）'
  const statusText = p.enabled === false ? '隐藏' : '启用'
  return `Provider ${p.id}${nameText}（${typeText}）${statusText}${markText}`
}

// 拉取动作/结果 → 详细日志行数组 [{ text, type }]（纯函数，可单测）
// 在 buildProviderLogText 的摘要基础上，逐条输出每个 provider 明细与各源失败原因：
//   - 开始行：同 buildProviderLogText({ force })
//   - 云端合并成功：摘要（含 Custom/BYOK 计数）+ 每个 provider 一行 + 源失败 warn 行
//   - 只读降级：摘要 + 降级原因 + 本地缓存每个 provider 一行
//   - 失败：单行错误
// 入参除 buildProviderLogText 同名项外：
//   providers      — 展示数组（含 id/name/type/enabled/mark）
//   sourceCounts   — { custom, byok }（后端 /api/providers 响应字段）
//   cloudErrors    — [{ source, message }]（各源失败；'cloud' 表示整体拉取抛错）
//   degradedReason — 'no-token' | 'no-gateway' | 'fetch-failed' | ''（只读降级原因）
export function buildProviderDetailLogs({
  force, ok, count, readonly, error,
  providers = [], sourceCounts = {}, cloudErrors = [], degradedReason = '',
} = {}) {
  if (ok === undefined) {
    return [{ text: buildProviderLogText({ force }), type: 'info' }]
  }
  if (!ok) {
    return [{ text: buildProviderLogText({ force, ok: false, error }), type: 'err' }]
  }
  const lines = []
  if (readonly) {
    // 只读降级：本地缓存展示（mark 全 null）
    lines.push({ text: `拉取完成：只读降级，展示本地缓存 ${count} 个 Provider`, type: 'warn' })
    if (degradedReason === 'no-token') {
      lines.push({ text: '原因：未配置管理 API Token（环境变量或本地安全存储）', type: 'warn' })
    } else if (degradedReason === 'no-gateway') {
      lines.push({ text: '原因：gateway 配置不完整（缺 accountId / gatewayId）', type: 'warn' })
    } else if (degradedReason === 'fetch-failed') {
      for (const e of cloudErrors) {
        lines.push({ text: `云端拉取失败：${e.message || '未知错误'}`, type: 'warn' })
      }
    }
    for (const p of providers) lines.push({ text: buildProviderLogLine(p, false), type: 'info' })
    return lines
  }
  // 云端合并成功
  const c = Number.isFinite(sourceCounts.custom) ? sourceCounts.custom : 0
  const b = Number.isFinite(sourceCounts.byok) ? sourceCounts.byok : 0
  lines.push({ text: `拉取完成：云端合并 ${count} 个 Provider（Custom ${c} / BYOK ${b}）`, type: 'ok' })
  for (const p of providers) lines.push({ text: buildProviderLogLine(p, true), type: 'info' })
  // 部分源失败：合并结果不完整，逐条提示（不标 removed 的原因在此）
  for (const e of cloudErrors) {
    const srcName = e.source === 'custom-providers'
      ? 'Custom Providers'
      : e.source === 'provider_configs'
        ? 'BYOK provider_configs'
        : e.source || 'cloud'
    lines.push({ text: `[${srcName}] 拉取失败：${e.message || '未知错误'}（合并结果可能不完整）`, type: 'warn' })
  }
  return lines
}

// ── 添加 Provider（FP4）：表单字段 / 载荷校验 / 结果日志（纯函数，可单测）──
// type：'byok' → slug/name/apiKey；'custom-provider' → slug/name/baseUrl/apiKey/pathPrefix。
// 非法 type 返回 []（与 buildEditFields 的「未知一律空」约定一致，绝不抛错）。
export function buildAddFields(type) {
  const slug = {
    name: 'slug', label: 'Provider ID（slug）', type: 'text', value: '',
    placeholder: '如 openai / anthropic / deepseek',
  }
  const name = {
    name: 'name', label: '名称（选填）', type: 'text', value: '',
    placeholder: '缺省同 slug',
  }
  if (type === 'byok') {
    return [
      slug,
      name,
      { name: 'apiKey', label: 'API Key（必填）', type: 'password', value: '', placeholder: '输入 Provider API Key' },
    ]
  }
  if (type === 'custom-provider') {
    return [
      slug,
      name,
      { name: 'baseUrl', label: 'Base URL（必填）', type: 'text', value: '', placeholder: 'https://…', hint: BASE_URL_HINT },
      { name: 'apiKey', label: 'API Key（选填）', type: 'password', value: '', placeholder: '写入 Authorization: Bearer 头，可留空' },
      { name: 'pathPrefix', label: 'API 路径前缀（选填）', type: 'text', value: '', placeholder: '如 /api/v3，留空使用默认 /v1' },
    ]
  }
  return []
}

// 添加表单值 → 载荷或拦截原因（{ blocked } 约定与 buildEditChanges 一致）
// 校验：slug 匹配 /^[a-z0-9][a-z0-9-]{0,62}$/；byok 必有非空 apiKey；custom 必有
// http(s) baseUrl。各值 trim；选填项 trim 后为空 → 不出现在 body 中（name 缺省由后端取 slug）。
export function buildAddPayload(type, values) {
  const v = values || {}
  const str = (k) => (typeof v[k] === 'string' ? v[k].trim() : '')
  const slug = str('slug')
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return { blocked: '请填写 Provider ID（小写字母/数字/连字符，首字符为字母或数字）' }
  }
  const body = { type, id: slug }
  const apiKey = str('apiKey')
  const baseUrl = str('baseUrl')
  if (type === 'byok') {
    if (apiKey === '') return { blocked: 'BYOK 需要填写 API Key' }
    body.apiKey = apiKey
  } else if (type === 'custom-provider') {
    if (baseUrl === '') return { blocked: '请填写 Base URL（https://…）' }
    if (!/^https?:\/\//.test(baseUrl)) return { blocked: 'Base URL 需以 http:// 或 https:// 开头' }
    body.baseUrl = baseUrl
    if (apiKey !== '') body.apiKey = apiKey
    const pathPrefix = str('pathPrefix')
    if (pathPrefix !== '') body.pathPrefix = pathPrefix
  } else {
    return { blocked: '未知 Provider 类型' }
  }
  const name = str('name')
  if (name !== '') body.name = name
  return { body }
}

// 添加结果 → 日志行数组 [{ text, type }]（纯函数，可单测）
// 云端创建成功 + 本地写入成功 → 单行 ok；kvWarn 为真时追加 warn 行（KV 路由同步失败，
// 可到模型页点「部署更改」重试，不阻断创建结果展示）。
export function buildAddResultLogs({ id, type, kvWarn, kvError } = {}) {
  const typeText = type === 'byok' ? 'BYOK' : 'Custom'
  const lines = [{ text: `添加 Provider：${id}（${typeText}，云端创建成功，已写入本地）`, type: 'ok' }]
  if (kvWarn) {
    lines.push({ text: `路由同步 KV 失败：${kvError || ''}（可到模型页点【部署更改】重试）`, type: 'warn' })
  }
  return lines
}

// 视图局部样式（style.css 不在本任务改动范围内，随视图注入一次；
// .empty-hint/.status-* 与任务 31 同源，注入一份避免渲染顺序依赖）
function injectProvidersStyles() {
  if (document.getElementById('providers-view-styles')) return
  const style = document.createElement('style')
  style.id = 'providers-view-styles'
  style.textContent = `
    .providers-view { margin-top: 0.75rem; }
    .warn-bar {
      background: rgba(249, 226, 175, 0.12); color: var(--warn);
      border: 1px solid var(--warn); border-radius: 6px;
      padding: 0.5rem 0.75rem; margin-bottom: 0.75rem; font-size: 0.85rem;
    }
    .providers-view .table-wrap { margin-top: 0.75rem; overflow-x: auto; }
    .empty-hint { padding: 1.5rem; text-align: center; color: var(--muted); font-size: 0.9rem; }
    .provider-table th:nth-child(1), .provider-table td:nth-child(1) { min-width: 120px; }
    .provider-table th:nth-child(2), .provider-table td:nth-child(2) { min-width: 140px; }
    /* 可排序表头：hover/激活态高亮，▲▼ 指示器小号显示 */
    .provider-table th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    .provider-table th.sortable:hover, .provider-table th.sorted { color: var(--accent); }
    .provider-table .sort-ind { margin-left: 0.25em; font-size: 0.7rem; }
    .provider-table .btn-edit, .provider-table .btn-delete {
      background: transparent; color: var(--fg); border: 1px solid var(--border);
      border-radius: 6px; padding: 0.15rem 0.5rem; cursor: pointer; font-size: 0.85rem;
    }
    .provider-table .btn-edit:hover { border-color: var(--accent); color: var(--accent); }
    .provider-table .btn-delete:hover { border-color: var(--err); color: var(--err); }
    .status-ok { color: var(--ok); }
    .status-err { color: var(--err); }
    .status-hidden { color: var(--muted); }
    .field-readonly {
      color: var(--muted); border: 1px dashed var(--border); border-radius: 6px;
      padding: 0.35rem 0.5rem; margin-top: 0.15rem; font-size: 0.9rem;
    }
  `
  document.head.appendChild(style)
}

// Provider 视图渲染器（闭包持有视图局部状态；Node 无 DOM 时直接返回）
export function renderProvidersView(container) {
  if (!container || typeof document === 'undefined') return
  if (container.dataset.providersRendered) return // 幂等保护（renderView 已保证懒渲染一次）
  container.dataset.providersRendered = '1'

  injectProvidersStyles()

  // ── 视图局部状态 ────────────────────────────────────────
  let providers = []       // 展示数组（GET /api/providers 的 providers）
  let readonly = false     // 响应顶层 readonly（已知坑 4：不是每个 provider 的字段）
  let sortKey = null       // 列排序（th[data-sort]，null = 后端默认顺序）
  let sortDir = 'asc'      // 排序方向（asc/desc，sortKey=null 时无意义）

  // ── DOM 骨架（§4.1 结构）────────────────────────────────
  container.innerHTML = `
    <h2 class="view-title">Provider</h2>
    <div class="providers-view">
      <div id="providers-warn" class="warn-bar" hidden>
        ⚠ 只读模式：未配置管理 Token 或云端/KV 不可用，编辑功能已禁用
      </div>
      <div class="table-wrap">
        <table class="provider-table">
          <thead><tr>
            <th class="sortable" data-sort="slug" title="点击排序">slug<span class="sort-ind" hidden></span></th>
            <th class="sortable" data-sort="name" title="点击排序">name<span class="sort-ind" hidden></span></th>
            <th class="sortable" data-sort="type" title="点击排序">type<span class="sort-ind" hidden></span></th>
            <th class="sortable" data-sort="visibility" title="点击排序">可见性<span class="sort-ind" hidden></span></th>
            <th class="sortable" data-sort="mark" title="点击排序">状态<span class="sort-ind" hidden></span></th>
            <th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div class="empty-hint" id="hint-no-provider" hidden>无 Provider（点击「更新 Provider 列表」从云端拉取）</div>
      </div>
    </div>
  `

  const warnBar = container.querySelector('#providers-warn')
  // 刷新按钮在右侧提示栏下方（#side-actions，index.html 静态定义，随视图显隐）
  const btnRefresh = document.getElementById('btn-provider-refresh')
  // 添加按钮：#side-actions 静态定义；首次渲染前禁用，refreshProviders 成功后由 applyReadonlyUI 恢复
  const btnAdd = document.getElementById('btn-provider-add')
  btnAdd.disabled = true
  const tbody = container.querySelector('.provider-table tbody')
  const emptyHint = container.querySelector('#hint-no-provider')

  // ── 渲染辅助 ────────────────────────────────────────────
  // 表头排序指示器（aria-sort + ▲/▼，随 sortKey/sortDir 同步）
  function updateSortIndicators() {
    for (const th of container.querySelectorAll('th[data-sort]')) {
      const active = th.dataset.sort === sortKey
      const ind = th.querySelector('.sort-ind')
      th.classList.toggle('sorted', active)
      th.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none')
      if (!ind) continue
      ind.hidden = !active
      ind.textContent = sortDir === 'asc' ? '▲' : '▼'
    }
  }

  function renderTable() {
    updateSortIndicators()
    const getter = sortKey ? PROVIDER_SORT_GETTERS[sortKey] : null
    const rows = buildProviderTableRows(getter ? sortViewItems(providers, getter, sortDir) : providers, readonly)
    tbody.innerHTML = rows.map((r) => r.html).join('')
    // 空状态（已知坑 10）：只读且本地也空 → 一并提示先配置管理 Token
    emptyHint.hidden = providers.length > 0
    if (providers.length === 0) {
      emptyHint.textContent = '无 Provider（点击「更新 Provider 列表」从云端拉取）'
      if (readonly) emptyHint.textContent += '；请先配置管理 Token'
    }
  }

  function applyReadonlyUI() {
    warnBar.hidden = !readonly
    // 只读模式添加必失败（云端创建需管理 Token），与编辑/删除按钮 disabled 语义一致
    btnAdd.disabled = readonly
  }

  // 拉取：首次 GET /api/providers；手动更新按钮强制 POST /api/providers/refresh（语义同 GET）
  // 拉取进度只写入页面底部全局处理过程日志栏（与其余操作统一展示，视图内不再单独放日志面板）
  // 已知坑 9：拉取期间按钮禁用 + 文案「更新中…」，防止连点
  // 超时兜底（30s，与后端 Cloudflare 拉取上限一致）：后端挂起时按钮能恢复为可点
  // 「更新 Provider 列表」，视图不会永远停在「更新中…」假死（无超时即表现为「没有按钮」）
  const FETCH_TIMEOUT = 30_000
  async function refreshProviders(force) {
    btnRefresh.disabled = true
    const prevText = btnRefresh.textContent
    btnRefresh.textContent = '更新中…'
    // 详细日志：开始行 + 结果摘要 + 每个 provider 逐条 + 各源失败（buildProviderDetailLogs）
    for (const l of buildProviderDetailLogs({ force })) logActivity(l.text, l.type)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      const res = await withBusy(force ? '正在更新 Provider 列表…' : '正在加载 Provider 列表…', api(force ? '/api/providers/refresh' : '/api/providers', {
        method: force ? 'POST' : 'GET',
        signal: controller.signal,
      }))
      providers = Array.isArray(res.providers) ? res.providers : []
      readonly = res.readonly === true
      renderTable()
      applyReadonlyUI()
      const logs = buildProviderDetailLogs({
        force,
        ok: true,
        count: providers.length,
        readonly,
        providers,
        sourceCounts: res.sourceCounts,
        cloudErrors: res.cloudErrors,
        degradedReason: res.degradedReason,
      })
      for (const l of logs) logActivity(l.text, l.type)
    } catch (err) {
      flash(err.message, 'err')
      for (const l of buildProviderDetailLogs({ force, ok: false, error: err.message })) logActivity(l.text, l.type)
    } finally {
      clearTimeout(timer)
      btnRefresh.textContent = prevText
      btnRefresh.disabled = false
    }
  }

  // ── 变更操作（响应驱动更新内存态，再重渲染；已知坑 5）────
  async function editProvider(id) {
    const provider = providers.find((p) => p.id === id)
    if (!provider) return
    const values = await promptDialog(`编辑 Provider：${id}`, buildEditFields(provider, { readonly }))
    if (!values) return
    // 云端变更（name/apiKey）+ 本地变更（hidden/pathPrefix）分离组装
    const cloudChanges = buildEditChanges(provider, values)
    if (cloudChanges.blocked) {
      flash(cloudChanges.blocked, 'warn')
      return
    }
    const localChanges = buildLocalChanges(provider, values)
    const hasCloudChange = cloudChanges.name !== null || cloudChanges.apiKey !== null || cloudChanges.baseUrl !== null
    const visibilityChanged = localChanges && typeof localChanges.localEnabled === 'boolean'
    if (!hasCloudChange && !localChanges) return // 无任何变更，不发请求
    try {
      const res = await withBusy('正在更新 Provider…', api('/api/providers/update', {
        method: 'POST',
        body: { id, changes: { ...cloudChanges, ...(localChanges || {}) } },
      }))
      // 已知坑 5：用响应 provider 替换本地数组对应项再重渲染（不整页重拉）
      if (res.provider) {
        const idx = providers.findIndex((p) => p.id === id)
        if (idx >= 0) providers[idx] = res.provider
        else providers.push(res.provider)
        renderTable()
      }
      // KV 同步：可见性与路由都写 KV；失败提示可重试
      const kvWarn = res.kvDeployed === false && res.kvSkipped !== true
      flash(kvWarn
        ? `已保存修改，但同步 KV 失败：${res.kvError || '未知错误'}（可到模型页点【部署更改】重试）`
        : '已保存修改', kvWarn ? 'warn' : 'ok')
      // 详细日志：逐字段列出实际提交的变更
      const parts = []
      if (cloudChanges.name) parts.push(`名称 → ${cloudChanges.name}`)
      if (cloudChanges.apiKey) parts.push('覆盖 API Key')
      if (cloudChanges.baseUrl) parts.push(`Base URL → ${cloudChanges.baseUrl}`)
      if (visibilityChanged) {
        parts.push(`状态 → ${localChanges.localEnabled ? '启用' : '隐藏'}`)
      }
      if (localChanges && typeof localChanges.pathPrefix === 'string') {
        parts.push(localChanges.pathPrefix ? `路由前缀 → ${localChanges.pathPrefix}` : '清除路由前缀')
      }
      const scope = hasCloudChange ? '云端 + 本地' : '本地'
      let tail = scope
      if (visibilityChanged || (localChanges && typeof localChanges.pathPrefix === 'string')) {
        tail += kvWarn ? '；KV 同步失败' : '；已同步 KV'
      }
      logActivity(`更新 Provider：${id}（${parts.join('、') || '无字段变更'}；${tail}）`,
        kvWarn ? 'warn' : 'ok')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`更新 Provider 失败：${id}（${err.message}）`, 'err')
    }
  }

  async function deleteProvider(id) {
    const provider = providers.find((p) => p.id === id)
    if (!provider) return
    // 已知坑 8：确认文案必须含「同步删除云端配置与本地记录」，danger 变体
    const yes = await confirmDialog('删除 Provider', `将同步删除云端配置与本地记录：${provider.id}？`, {
      danger: true,
    })
    if (!yes) return
    try {
      const res = await withBusy('正在删除 Provider…', api('/api/providers/delete', { method: 'POST', body: { id } }))
      if (res && res.removed === true) {
        providers = providers.filter((p) => p.id !== id)
        renderTable()
        // 详细日志：标注类型 + 云端删除结果（cloudAction 由后端返回）
        const typeText = provider.type === 'byok' ? 'BYOK' : 'Custom'
        const actionText = ({
          'deleted': '云端删除成功',
          'not-found': '云端条目已不存在（404）',
          'skipped-already-removed': '云端已无该条目，跳过云端删除',
          'offline-only': '未配置管理 Token，仅本地移除',
          'already-gone': '本地已无此条目',
          'unknown': '云端状态未知',
        })[res.cloudAction] || res.cloudAction || 'unknown'
        const kvWarn = res.kvDeployed === false && res.kvSkipped !== true
        let deleteLog = `删除 Provider：${id}（${typeText}，${actionText}）`
        if (kvWarn) {
          deleteLog += '；路由同步 KV 失败'
          flash(`已删除，但路由同步 KV 失败：${res.kvError || '未知错误'}（可到模型页点【部署更改】重试）`, 'warn')
        } else {
          flash('已删除', 'ok')
        }
        logActivity(deleteLog, kvWarn ? 'warn' : 'ok')
      }
    } catch (err) {
      // 已知坑 3：[云端已删] 条目删除时后端 400「缺少云端 ID，请先刷新」→
      // 透传该 reason 提示先点刷新（可接受降级，测试不覆盖此路径）
      flash(err.message, 'err')
      logActivity(`删除 Provider 失败：${id}（${err.message}）`, 'err')
    }
  }

  // 添加 Provider（FP5）：两步表单（先选类型，再填字段）→ buildAddPayload 校验 →
  // POST /api/providers/create → 响应 provider push 进内存再 renderTable（已知坑 5，不整页重拉）
  async function addProvider() {
    // 第一步：选择类型（byok / custom-provider）
    const typePick = await promptDialog('添加 Provider', [
      {
        name: 'type', label: '类型', type: 'select',
        options: [
          { value: 'byok', label: 'BYOK（官方厂商 Key）' },
          { value: 'custom-provider', label: 'Custom Provider（自定义 base URL）' },
        ],
        value: 'byok',
      },
    ])
    if (!typePick) return
    // 第二步：按所选类型生成字段表单
    const typeLabel = typePick.type === 'byok' ? 'BYOK（官方厂商 Key）' : 'Custom Provider（自定义 base URL）'
    const values = await promptDialog(`添加 Provider：${typeLabel}`, buildAddFields(typePick.type))
    if (!values) return
    const payload = buildAddPayload(typePick.type, values)
    if (payload.blocked) {
      flash(payload.blocked, 'warn')
      return
    }
    try {
      const res = await withBusy('正在添加 Provider…', api('/api/providers/create', {
        method: 'POST',
        body: payload.body,
      }))
      // 已知坑 5：用响应 provider push 进内存再重渲染（不整页重拉）
      if (res.provider) {
        providers.push(res.provider)
        renderTable()
      }
      // KV 同步：带 pathPrefix 才推路由；失败提示可重试（不阻断创建结果展示）
      const kvWarn = res.kvDeployed === false && res.kvSkipped !== true
      flash(kvWarn
        ? `已添加，但路由同步 KV 失败：${res.kvError || '未知错误'}（可到模型页点【部署更改】重试）`
        : '已添加', kvWarn ? 'warn' : 'ok')
      // 详细日志：云端创建成功 + KV 同步结果逐条输出
      for (const l of buildAddResultLogs({
        id: res.provider && res.provider.id,
        type: res.provider && res.provider.type,
        kvWarn,
        kvError: res.kvError,
      })) logActivity(l.text, l.type)
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`添加 Provider 失败：${err.message}`, 'err')
    }
  }

  // ── 事件绑定 ────────────────────────────────────────────
  // 表头点击排序：三态循环 未排序 → 升序 → 降序 → 未排序（纯前端，重渲染即可）
  container.querySelector('.provider-table thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]')
    if (!th) return
    ;({ key: sortKey, dir: sortDir } = nextSortState(sortKey, sortDir, th.dataset.sort))
    renderTable()
  })

  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    const tr = btn.closest('tr[data-provider-id]')
    if (!tr || !tr.dataset.providerId) return
    if (btn.classList.contains('btn-edit')) editProvider(tr.dataset.providerId)
    else if (btn.classList.contains('btn-delete')) deleteProvider(tr.dataset.providerId)
  })

  btnRefresh.addEventListener('click', () => refreshProviders(true))
  btnAdd.addEventListener('click', addProvider)

  // ── 初始加载：进入视图拉一次（§3.1 step 2）──
  refreshProviders(false)
}

// 注册 Provider 视图渲染器（覆盖任务 30 的占位渲染器，分派契约）
registerViewRenderer('providers', renderProvidersView)

// ── 任务 33：前端 Worker + 账户视图（纯函数 + 渲染器）─────────────────
// 数据流（交付包 §3.1）：两个视图各自进入时拉一次状态；部署 / update / clear 成功后
// 自动刷新状态（模型数 / KV key / 槽位状态可能变化，已知坑 7）。
// 清除影响面文案只从后端响应 impact 读取（任务 29 IMPACT_TEXT），前端不硬编码（已知坑 3）。

// 槽位名 → 展示文案（纯函数，视图与测试共用）
export function slotLabel(slot) {
  if (slot === 'management') return '管理 API Token'
  if (slot === 'gateway') return 'Gateway Token (cfut_xxx)'
  return slot // 非法值原样透传（测试 9）
}

// 槽位卡说明文案（§4.3 固定文案，与 VIEW_HINTS 一致）
const SLOT_NOTES = {
  management: '账户级凭证，绝不分发给各 PC',
  gateway: '绑定单个 gateway，可分发各 PC Agent',
}

// KV key 三态映射：exists→'存在'(ok) / error→'无法读取'(warn) / skipped→'未检查'(muted)
const KV_KEY_STATUS = {
  exists: { text: '存在', cls: 'ok' },
  error: { text: '无法读取', cls: 'warn' },
  skipped: { text: '未检查', cls: 'muted' },
}

// namespaceId 显示截断（已知坑 10）：前 4 + … + 后 4（如 2a3b…2k3l）；完整值由调用方放 title 属性
function truncateNamespaceId(id) {
  const s = String(id || '')
  if (s.length <= 8) return s
  return s.slice(0, 4) + '…' + s.slice(-4)
}

// /api/workers/status 响应 → 状态面板 HTML（§4.2）
// KV namespace（configured/id，id 截断 + title 完整值）/ models.json（exists/count）/
// KV key（三态映射）/ canDeploy → 面板底部「可部署 ✓」或「不可部署：先配置 KV namespace（账户视图初始化）」
export function buildWorkersStatusView(status) {
  const s = status || {}
  const ns = s.kvNamespace || {}
  const mj = s.modelsJson || {}
  const kv = s.kvKey || {}
  const nsId = ns.id != null ? ns.id : s.namespaceId != null ? s.namespaceId : ''
  const nsConfigured = ns.configured === true || !!nsId
  const nsText = nsConfigured ? `已配置 (${truncateNamespaceId(nsId)})` : '未配置'
  const nsTitle = nsConfigured ? ` title="${escapeHtml(String(nsId))}"` : ''
  const modelsText = mj.exists === true ? `存在（${mj.count} 个模型）` : '不存在'
  const modelsCls = mj.exists === true ? 'ok' : 'muted'
  const kvStatus = KV_KEY_STATUS[kv.status] || { text: kv.detail || String(kv.status || '未知'), cls: 'muted' }
  const kvName = s.kvKeyName || 'models'
  const deployText = s.canDeploy === true ? '可部署 ✓' : '不可部署：先配置 KV namespace（账户视图初始化）'
  const deployCls = s.canDeploy === true ? 'ok' : 'warn'
  return (
    `<div class="status-grid">` +
    `<div class="status-item"><span class="k">KV namespace</span><span class="v ${nsConfigured ? 'ok' : 'warn'}"${nsTitle}>${escapeHtml(nsText)}</span></div>` +
    `<div class="status-item"><span class="k">models.json</span><span class="v ${modelsCls}">${escapeHtml(modelsText)}</span></div>` +
    `<div class="status-item"><span class="k">KV key (${escapeHtml(kvName)})</span><span class="v ${kvStatus.cls}">${escapeHtml(kvStatus.text)}</span></div>` +
    `<div class="status-item"><span class="k">部署</span><span class="v ${deployCls}">${escapeHtml(deployText)}</span></div>` +
    `</div>`
  )
}

// 槽位状态行：mark + label（source 映射由后端给）；env 提供时附「本地未存/已存」提示（§3.2）
function slotStatusLine(entry) {
  const e = entry || {}
  let line = `${e.mark || '○'} ${e.label || '未配置'}`
  if (e.source === 'env') line += e.hasLocal ? '（本地已存）' : '（本地未存）'
  return line
}

// /api/account/status 响应 → 账户面板 HTML（§4.3）
// gateway 卡：accountId / gatewayId（'未配置' → warn 色；两者都未配置 → 整卡提示初始化，已知坑 8）
// 槽位卡 ×2（management / gateway）：标题 + 说明文案 + 状态行 + 更新/清除按钮（data-slot 供事件委托）
export function buildAccountStatusView(tokens, gateway) {
  const t = tokens || {}
  const g = gateway || {}
  const accId = g.accountId != null ? String(g.accountId) : '未配置'
  const gwId = g.gatewayId != null ? String(g.gatewayId) : '未配置'
  const bothUnconfigured = accId === '未配置' && gwId === '未配置'
  const slotCards = ['management', 'gateway']
    .map((slot) => {
      const e = t[slot] || {}
      return (
        `<div class="panel slot-card" data-slot="${slot}">` +
        `<h3>${escapeHtml(slotLabel(slot))}</h3>` +
        `<p class="slot-note">${SLOT_NOTES[slot] || ''}</p>` +
        `<div class="slot-status">${escapeHtml(slotStatusLine(e))}</div>` +
        `<button class="btn-update" type="button" data-slot="${slot}">更新</button>` +
        `<button class="btn-clear" type="button" data-slot="${slot}">清除</button>` +
        `</div>`
      )
    })
    .join('')
  return (
    `<div class="panel gateway-card">` +
    `<h3>Gateway 信息</h3>` +
    `<div class="status-item"><span class="k">accountId</span><span class="v${accId === '未配置' ? ' warn' : ''}">${escapeHtml(accId)}</span></div>` +
    `<div class="status-item"><span class="k">gatewayId</span><span class="v${gwId === '未配置' ? ' warn' : ''}">${escapeHtml(gwId)}</span></div>` +
    (bothUnconfigured ? `<p class="gateway-hint warn">尚未初始化，点击下方『初始化向导』</p>` : '') +
    `</div>` +
    slotCards
  )
}

// 视图局部样式（style.css 不在本任务改动范围内，随视图注入一次；
// .toolbar/.status-item/.panel 与任务 31/32 同源，注入一份避免渲染顺序依赖）
function injectWorkersAccountStyles() {
  if (document.getElementById('workers-account-view-styles')) return
  const style = document.createElement('style')
  style.id = 'workers-account-view-styles'
  style.textContent = `
    .workers-view, .account-view { margin-top: 0.75rem; }
    .view-note { color: var(--muted); font-size: 0.85rem; margin-bottom: 0.75rem; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0.35rem 1.5rem; }
    .status-item { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.9rem; padding: 0.25rem 0; border-bottom: 1px dashed var(--border); }
    .status-item:last-child { border-bottom: none; }
    .status-item .k { color: var(--muted); }
    .status-item .v.ok { color: var(--ok); }
    .status-item .v.warn { color: var(--warn); }
    .status-item .v.muted { color: var(--muted); }
    .toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
    .account-view .panel { border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
    .account-view .panel h3 { margin: 0 0 0.4rem; font-size: 0.95rem; }
    .slot-note { color: var(--muted); font-size: 0.8rem; margin: 0 0 0.4rem; }
    .slot-status { font-size: 0.9rem; margin-bottom: 0.5rem; }
    .gateway-hint.warn { color: var(--warn); font-size: 0.85rem; margin: 0.5rem 0 0; }
    .slot-card .btn-update, .slot-card .btn-clear {
      background: transparent; color: var(--fg); border: 1px solid var(--border);
      border-radius: 6px; padding: 0.15rem 0.5rem; cursor: pointer; font-size: 0.85rem;
    }
    .slot-card .btn-update:hover { border-color: var(--accent); color: var(--accent); }
    .slot-card .btn-clear:hover { border-color: var(--err); color: var(--err); }
  `
  document.head.appendChild(style)
}

// Worker 视图渲染器（闭包持有视图局部状态；Node 无 DOM 时直接返回）
export function renderWorkersView(container) {
  if (!container || typeof document === 'undefined') return
  if (container.dataset.workersRendered) return // 幂等保护（renderView 已保证懒渲染一次）
  container.dataset.workersRendered = '1'

  injectWorkersAccountStyles()

  // ── 视图局部状态 ────────────────────────────────────────
  let canDeploy = false  // 最近一次状态响应（部署按钮可用性）
  let deploying = false  // 部署状态机：deploying 期间按钮禁用 + 「部署中…」

  // ── DOM 骨架（§4.1 结构）────────────────────────────────
  container.innerHTML = `
    <h2 class="view-title">Worker</h2>
    <div class="workers-view">
      <p class="view-note">Worker 代码无需修改，此视图仅管理部署</p>
      <div class="status-panel" id="workers-status"></div>
      <div class="toolbar">
        <button id="btn-worker-deploy" class="btn btn-default" type="button">部署 Worker</button>
        <button id="btn-worker-refresh" class="btn btn-default" type="button">刷新状态</button>
      </div>
    </div>
  `

  const statusPanel = container.querySelector('#workers-status')
  const btnDeploy = container.querySelector('#btn-worker-deploy')
  const btnRefresh = container.querySelector('#btn-worker-refresh')

  // ── 渲染辅助 ────────────────────────────────────────────
  function renderStatus(res) {
    statusPanel.innerHTML = buildWorkersStatusView(res)
    canDeploy = res && res.canDeploy === true
    applyDeployUI()
  }

  // 部署按钮可用性：canDeploy=false → 禁用 + title 提示先配置 KV
  function applyDeployUI() {
    btnDeploy.disabled = deploying || !canDeploy
    btnDeploy.title = canDeploy ? '' : '先配置 KV namespace（账户视图初始化）'
  }

  // 拉取状态（已知坑 9：请求期间刷新按钮禁用防连点；失败 flash 后恢复）
  async function refreshStatus() {
    btnRefresh.disabled = true
    const prevText = btnRefresh.textContent
    btnRefresh.textContent = '刷新中…'
    logActivity('获取 Worker 状态…', 'info')
    try {
      const res = await withBusy('正在获取 Worker 状态…', api('/api/workers/status'))
      renderStatus(res)
      const mj = res.modelsJson || {}
      logActivity(
        `Worker 状态：模型 ${mj.count != null ? mj.count : '?'} 个 / KV key ${res.kvKeyExists === true ? '存在' : '不存在'} / ${res.canDeploy === true ? '可部署' : '不可部署'}`,
        'ok',
      )
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`获取 Worker 状态失败：${err.message}`, 'err')
    } finally {
      btnRefresh.textContent = prevText
      btnRefresh.disabled = false
    }
  }

  // 部署（已知坑 1/2：wrangler 长请求，期间按钮禁用 + 「部署中…」防重复；失败时
  // flash 只显示前 200 字符 output，完整 output 放 dialog <pre>，escapeHtml 防 HTML 注入）
  async function deploy() {
    if (deploying) return
    deploying = true
    applyDeployUI()
    const prevText = btnDeploy.textContent
    btnDeploy.textContent = '部署中…'
    logActivity('开始部署 Worker…', 'info')
    try {
      const res = await withBusy('正在部署 Worker（wrangler）…', api('/api/workers/deploy', { method: 'POST' }))
      if (res && res.ok === true) {
        flash('部署成功', 'ok')
        logActivity('Worker 部署成功', 'ok')
        refreshStatus() // 模型数 / KV key 可能变化（已知坑 7）
      } else {
        const output = (res && res.output) || ''
        flash(`部署失败：${output.slice(0, 200)}`, 'err')
        logActivity(`Worker 部署失败：${output.slice(0, 200)}`, 'err')
        showDialog({ title: '部署输出', body: `<pre class="deploy-output">${escapeHtml(output)}</pre>` })
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 500 && err.message === 'deploy timeout') {
        flash('部署超时', 'err')
        logActivity('Worker 部署超时', 'err')
      } else {
        flash(err.message, 'err')
        logActivity(`Worker 部署失败：${err.message}`, 'err')
      }
    } finally {
      deploying = false
      btnDeploy.textContent = prevText
      applyDeployUI()
    }
  }

  // ── 事件绑定 ────────────────────────────────────────────
  btnDeploy.addEventListener('click', deploy)
  btnRefresh.addEventListener('click', refreshStatus)

  // ── 初始加载：进入视图拉一次（§3.1 step 2）──
  refreshStatus()
}

// 账户视图渲染器（闭包持有视图局部状态；Node 无 DOM 时直接返回）
export function renderAccountView(container) {
  if (!container || typeof document === 'undefined') return
  if (container.dataset.accountRendered) return // 幂等保护（renderView 已保证懒渲染一次）
  container.dataset.accountRendered = '1'

  injectWorkersAccountStyles()

  // ── DOM 骨架（§4.3 结构）────────────────────────────────
  container.innerHTML = `
    <h2 class="view-title">账户</h2>
    <div class="account-view">
      <div id="account-status"><!-- buildAccountStatusView 输出 --></div>
      <div class="toolbar">
        <button id="btn-setup" class="btn btn-default" type="button">初始化向导</button>
      </div>
    </div>
  `

  const statusBox = container.querySelector('#account-status')
  const btnSetup = container.querySelector('#btn-setup')

  // ── 渲染辅助 ────────────────────────────────────────────
  function renderStatus(res) {
    const tokens = (res && res.tokens) || {}
    statusBox.innerHTML = buildAccountStatusView(tokens, res && res.gateway)
    // 已知坑 5：env 提供的 token 无法清除（clear-token 只清本地槽位）→ 按钮禁用 + title
    for (const slot of ['management', 'gateway']) {
      const clearBtn = statusBox.querySelector(`.btn-clear[data-slot="${slot}"]`)
      if (!clearBtn) continue
      const entry = tokens[slot] || {}
      if (entry.source === 'env') {
        clearBtn.disabled = true
        clearBtn.title = 'env 提供的 Token 请从环境变量移除'
      }
    }
  }

  async function refreshStatus() {
    logActivity('获取账户状态…', 'info')
    try {
      const res = await withBusy('正在获取账户状态…', api('/api/account/status'))
      renderStatus(res)
      const t = (res && res.tokens) || {}
      const mgmt = t.management || {}
      const gw = t.gateway || {}
      logActivity(
        `账户状态：管理 Token ${mgmt.mark === '●' ? '已配置' : '未配置'} / Gateway Token ${gw.mark === '●' ? '已配置' : '未配置'}`,
        'ok',
      )
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`获取账户状态失败：${err.message}`, 'err')
    }
  }

  // 更新 token（已知坑 4：空提交 → 后端 { ok:false, skipped:true } → 静默不提示）
  async function updateToken(slot) {
    const values = await promptDialog(`更新 ${slotLabel(slot)}`, [
      { name: 'token', label: slotLabel(slot), type: 'password' },
    ])
    if (!values) return // 取消
    try {
      const res = await withBusy('正在更新 Token…', api('/api/account/update-token', {
        method: 'POST',
        body: { slot, token: values.token },
      }))
      if (res && res.ok === true) {
        flash('已保存', 'ok')
        logActivity(`已更新 ${slotLabel(slot)}`, 'ok')
        refreshStatus() // 槽位状态变化（已知坑 7）
      }
      // skipped → 静默
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`更新 ${slotLabel(slot)} 失败：${err.message}`, 'err')
    }
  }

  // 清除 token（已知坑 3：确认框用通用文案，影响面文案只从后端响应 impact 读）
  async function clearToken(slot) {
    const yes = await confirmDialog(
      `清除 ${slotLabel(slot)}？`,
      '清除后相关功能将不可用（可随时重新配置）',
      { danger: true },
    )
    if (!yes) return
    try {
      const res = await withBusy('正在清除 Token…', api('/api/account/clear-token', { method: 'POST', body: { slot } }))
      if (res && res.impact) flash(res.impact, 'warn')
      logActivity(`已清除 ${slotLabel(slot)}`, 'warn')
      refreshStatus()
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`清除 ${slotLabel(slot)} 失败：${err.message}`, 'err')
    }
  }

  // 初始化向导（已知坑 6：stdio inherit 在服务器终端交互，浏览器只 flash 提示）
  async function runSetup() {
    const yes = await confirmDialog('运行初始化向导？', '向导将在服务器终端启动，请切换到终端完成 7 步配置')
    if (!yes) return
    btnSetup.disabled = true
    try {
      await withBusy('正在启动初始化向导…', api('/api/account/setup', { method: 'POST' }))
      flash('初始化向导已在终端启动', 'info')
      logActivity('初始化向导已在服务器终端启动（请切换到终端完成 7 步配置）', 'info')
    } catch (err) {
      flash(err.message, 'err')
      logActivity(`启动初始化向导失败：${err.message}`, 'err')
    } finally {
      btnSetup.disabled = false
    }
  }

  // ── 事件绑定（槽位卡按钮事件委托）───────────────────────
  statusBox.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn || !btn.dataset.slot) return
    if (btn.classList.contains('btn-update')) updateToken(btn.dataset.slot)
    else if (btn.classList.contains('btn-clear')) clearToken(btn.dataset.slot)
  })

  btnSetup.addEventListener('click', runSetup)

  // ── 初始加载：进入视图拉一次（§3.1 step 2）──
  refreshStatus()
}

// 注册 Worker / 账户视图渲染器（覆盖任务 30 的占位渲染器，分派契约）
registerViewRenderer('workers', renderWorkersView)
registerViewRenderer('account', renderAccountView)

// ── 心跳（服务器自动退出配套，桌面应用式关闭语义）────────────────
// 网页是 UI 的唯一入口：页面存活期间定期上报心跳，全部页面关闭后服务器
// 心跳超时自动退出。刷新场景：pagehide 发送 goodbye 加速退出，新页面首个
// 心跳（服务器宽限期内）到达即取消退出；仅当所有页面真正关闭才触发退出。
// 纯函数设计（fetchFn 注入），Node 测试可直接 import。
export const HEARTBEAT_INTERVAL = 3000 // 心跳周期（ms），需小于服务器心跳超时

export const HEARTBEAT_URL = '/api/heartbeat'

export function startHeartbeat({ interval = HEARTBEAT_INTERVAL, url = HEARTBEAT_URL, fetchFn = fetch } = {}) {
  const beat = () => {
    try {
      // keepalive：页面卸载瞬间的末次心跳也尽量送达；失败静默（服务器已退出等）
      fetchFn(url, { method: 'POST', keepalive: true }).catch(() => {})
    } catch {
      // 心跳失败不影响页面使用
    }
  }
  beat() // 首帧即上报，抵消 goodbye 宽限窗口（刷新后尽快恢复心跳）
  const timer = setInterval(beat, interval)
  return () => clearInterval(timer)
}

export function sendGoodbye(url = `${HEARTBEAT_URL}?goodbye=1`) {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false
  try {
    return navigator.sendBeacon(url)
  } catch {
    return false
  }
}

// 浏览器启动守卫（置于文件末尾：必须在全部 registerViewRenderer 之后执行，
// 否则初始视图会用任务 30 的占位渲染器渲染，真实渲染器注册后永远不会被调用）。
// Node import 不执行（顶层零 DOM 访问的前提）。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
  // 心跳 + goodbye：全部页面关闭后服务器自动退出（与桌面应用一致）
  startHeartbeat()
  window.addEventListener('pagehide', () => sendGoodbye())
}
