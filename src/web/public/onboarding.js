/**
 * Web 初始化引导（onboarding）前端视图
 *
 * 触发：启动后拉 /api/account/status，若 `initialized === false`（本机无管理 API Token）
 * 则自动显示引导浮层。两条路径：
 *   A. 没有 Cloudflare 账号 → 引导注册 + 创建管理 Token（纯文案 + 外链）
 *   B. 已经用过 aigd / 已有账号 → 填两个 Token，后端自动解析 account/gateway
 *
 * 设计：本模块不 import app.js（避免循环依赖），由 app.js 调用 initOnboarding({ api })
 * 注入请求函数。模块顶层零 DOM 访问，纯函数（isOnboardingNeeded / gatewayChoices /
 * requiredPermissionLines）可被 Node 测试直接 import。
 */

/** Cloudflare 注册页 */
export const CF_SIGNUP_URL = 'https://dash.cloudflare.com/sign-up'
/** Cloudflare API Tokens 页（创建/编辑管理令牌，与 setup 向导第 1 步一致） */
export const CF_API_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens'
/** 默认 gateway id（与后端 DEFAULT_GATEWAY_ID 一致） */
export const DEFAULT_GATEWAY_ID = 'cf-ai-gateway'

// ─── 纯函数（可单测）──────────────────────────────────────

/**
 * 是否需要进入引导：以 /api/account/status 的 initialized 字段判定。
 * 字段缺失（旧后端 / 拉取失败）时返回 false，避免误把正常环境挡在引导里。
 * @param {object|null|undefined} status
 * @returns {boolean}
 */
export function isOnboardingNeeded(status) {
  return Boolean(status && status.initialized === false)
}

/**
 * 网关选择项：已有网关 + 「新建默认网关」兜底项。
 * 无网关时仅返回新建项；默认网关已在列表时不再重复追加。
 * @param {Array<{id: string}>} gateways
 * @param {string} [defaultId]
 * @returns {Array<{ value: string, label: string, create?: boolean }>}
 */
export function gatewayChoices(gateways, defaultId = DEFAULT_GATEWAY_ID) {
  const out = []
  const seen = new Set()
  for (const g of Array.isArray(gateways) ? gateways : []) {
    if (!g || typeof g.id !== 'string' || !g.id || seen.has(g.id)) continue
    seen.add(g.id)
    out.push({ value: g.id, label: g.id })
  }
  if (!seen.has(defaultId)) {
    out.push({ value: defaultId, label: `新建默认网关 ${defaultId}`, create: true })
  }
  return out
}

/**
 * 所需权限行文案：「<作用域> · <资源> · <访问级别>」+ 必需/建议标记
 * @param {Array<object>} permissions - /api/account/status 的 requiredPermissions
 * @returns {Array<{ label: string, required: boolean, reason: string }>}
 */
export function requiredPermissionLines(permissions) {
  return (Array.isArray(permissions) ? permissions : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      label: `${p.scope || ''} · ${p.resource || ''} · ${p.access || ''}`.trim(),
      required: p.required !== false,
      reason: typeof p.reason === 'string' ? p.reason : '',
    }))
}

// ─── DOM 视图 ────────────────────────────────────────────

const OVERLAY_ID = 'onboarding'
let _ctx = null // { api, status, open }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function link(href, text, title) {
  const a = document.createElement('a')
  a.href = href
  a.textContent = text
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  if (title) a.title = title
  return a
}

function button(label, { primary = false } = {}) {
  const b = el('button', `btn btn-${primary ? 'primary' : 'default'}`, label)
  b.type = 'button'
  return b
}

/** 浮层 / 主体容器（缺失时返回 null，纯 Node 环境安全） */
function overlayEl() {
  if (typeof document === 'undefined') return null
  return document.getElementById(OVERLAY_ID)
}

function showOverlay() {
  const root = overlayEl()
  if (!root) return
  root.hidden = false
  document.body.classList.add('onboarding-active')
}

function hideOverlay() {
  const root = overlayEl()
  if (!root) return
  root.hidden = true
  document.body.classList.remove('onboarding-active')
}

/** 渲染分支选择页 */
function renderChoose(body) {
  body.innerHTML = ''
  body.append(el('p', 'onboarding-desc', '本机尚未配置管理 API Token。请选择你的情况：'))

  const cards = el('div', 'onboarding-cards')

  const cardA = el('div', 'onboarding-card')
  cardA.append(el('h3', null, '我没有 Cloudflare 账号'))
  cardA.append(el('p', null, '先注册 Cloudflare 账号，并创建一个管理 API Token（账户级），再回来填写。'))
  const btnA = button('查看创建步骤', { primary: true })
  btnA.addEventListener('click', () => renderAccountGuide(body))
  cardA.append(btnA)

  const cardB = el('div', 'onboarding-card')
  cardB.append(el('h3', null, '我已经用过 aigd / 已有账号'))
  cardB.append(el('p', null, '直接填入两个 Token，工具会自动读取账号与网关并完成配置。'))
  const btnB = button('填写 Token', { primary: true })
  btnB.addEventListener('click', () => renderForm(body))
  cardB.append(btnB)

  cards.append(cardA, cardB)
  body.append(cards)
}

/** 渲染「没有账号」引导页（纯文案 + 外链） */
function renderAccountGuide(body) {
  body.innerHTML = ''
  body.append(el('p', 'onboarding-desc', '按下面三步准备，完成后回到本页填写 Token。'))

  const ol = el('ol', 'onboarding-steps')

  const li1 = el('li')
  li1.append(el('strong', null, '注册 Cloudflare 账号'))
  li1.append(document.createTextNode('（已有账号可跳过）：'))
  li1.append(link(CF_SIGNUP_URL, '打开注册页 ↗', '打开 Cloudflare 注册页'))
  ol.append(li1)

  const li2 = el('li')
  li2.append(el('strong', null, '创建管理 API Token（账户级）'))
  li2.append(document.createTextNode('：'))
  li2.append(link(CF_API_TOKENS_URL, '打开 API Tokens 页 ↗', '打开 Cloudflare API Tokens 页'))
  const perms = requiredPermissionLines(_ctx && _ctx.status && _ctx.status.requiredPermissions)
  if (perms.length) {
    li2.append(el('p', 'onboarding-note', '建议权限（标 ★ 为必需）：'))
    const ul = el('ul', 'onboarding-perms')
    for (const p of perms) {
      const li = el('li')
      li.textContent = `${p.required ? '★ ' : ''}${p.label}`
      if (p.reason) {
        const reason = el('span', 'onboarding-reason', ` — ${p.reason}`)
        li.append(reason)
      }
      ul.append(li)
    }
    li2.append(ul)
  }
  ol.append(li2)

  const li3 = el('li')
  li3.append(el('strong', null, '创建 Gateway Token（cfut_xxx）'))
  li3.append(document.createTextNode('：在 Cloudflare 网关的 Settings 页 Authentication 区块创建，权限选 Run。'))
  ol.append(li3)

  body.append(ol)

  const actions = el('div', 'onboarding-actions')
  const back = button('返回')
  back.addEventListener('click', () => renderChoose(body))
  const go = button('我已准备好，填写 Token', { primary: true })
  go.addEventListener('click', () => renderForm(body))
  actions.append(back, go)
  body.append(actions)
}

/** 渲染「填写两个 Token」表单（路径 B） */
function renderForm(body) {
  body.innerHTML = ''
  body.append(el('p', 'onboarding-desc', '填入两个 Token，工具会自动读取账号与网关并完成配置。'))

  const form = el('div', 'onboarding-form')

  // 管理 Token
  const mgmtRow = el('label', 'onboarding-field')
  mgmtRow.append(el('span', 'onboarding-field-label', '管理 API Token（账户级）'))
  const mgmtInput = document.createElement('input')
  mgmtInput.type = 'password'
  mgmtInput.placeholder = '粘贴管理 API Token'
  mgmtInput.autocomplete = 'off'
  mgmtRow.append(mgmtInput)
  form.append(mgmtRow)

  const discoverBtn = button('读取账号', { primary: true })
  form.append(discoverBtn)

  // 账号选择（多账号时展示）
  const accountRow = el('label', 'onboarding-field')
  accountRow.append(el('span', 'onboarding-field-label', 'Cloudflare 账号'))
  const accountSelect = document.createElement('select')
  accountRow.append(accountSelect)
  accountRow.hidden = true
  form.append(accountRow)

  // 网关选择
  const gwRow = el('label', 'onboarding-field')
  gwRow.append(el('span', 'onboarding-field-label', 'AI Gateway'))
  const gwSelect = document.createElement('select')
  gwRow.append(gwSelect)
  gwRow.hidden = true
  form.append(gwRow)

  // cfut
  const cfutRow = el('label', 'onboarding-field')
  cfutRow.append(el('span', 'onboarding-field-label', 'Gateway Token（cfut_xxx）'))
  const cfutInput = document.createElement('input')
  cfutInput.type = 'password'
  cfutInput.placeholder = '粘贴 cfut_xxx'
  cfutInput.autocomplete = 'off'
  cfutRow.append(cfutInput)
  cfutRow.hidden = true
  form.append(cfutRow)

  const completeBtn = button('完成初始化', { primary: true })
  completeBtn.hidden = true
  form.append(completeBtn)

  const status = el('div', 'onboarding-status')
  form.append(status)

  body.append(form)

  const actions = el('div', 'onboarding-actions')
  const back = button('返回')
  back.addEventListener('click', () => renderChoose(body))
  actions.append(back)
  body.append(actions)

  // ── 状态（账户 + 网关）──
  let accounts = []
  let accountId = ''

  function setStatus(text, kind) {
    status.textContent = text || ''
    status.className = `onboarding-status${kind ? ' ' + kind : ''}`
  }

  function fillAccountSelect() {
    accountSelect.innerHTML = ''
    for (const a of accounts) {
      const opt = document.createElement('option')
      opt.value = a.id
      opt.textContent = a.name ? `${a.name}（${a.id}）` : a.id
      accountSelect.append(opt)
    }
    accountSelect.value = accountId
    accountRow.hidden = accounts.length <= 1
  }

  function fillGatewaySelect(gateways) {
    gwSelect.innerHTML = ''
    for (const c of gatewayChoices(gateways)) {
      const opt = document.createElement('option')
      opt.value = c.value
      opt.textContent = c.label
      gwSelect.append(opt)
    }
    // 优先选中已有网关的第一个（新建项仅作兜底）
    gwSelect.selectedIndex = 0
    gwRow.hidden = false
    cfutRow.hidden = false
    completeBtn.hidden = false
  }

  async function discover(selectedAccountId) {
    const managementToken = mgmtInput.value.trim()
    if (!managementToken) {
      setStatus('请先粘贴管理 API Token', 'err')
      return
    }
    discoverBtn.disabled = true
    setStatus('正在读取账号与网关…')
    try {
      const res = await _ctx.api('/api/onboarding/discover', {
        method: 'POST',
        body: { managementToken, accountId: selectedAccountId },
      })
      accounts = Array.isArray(res.accounts) ? res.accounts : []
      accountId = res.accountId || ''
      fillAccountSelect()
      fillGatewaySelect(res.gateways)
      setStatus(`读取成功：账号 ${accountId}，网关 ${(res.gateways || []).length} 个`, 'ok')
    } catch (err) {
      setStatus(`读取失败：${err.message}`, 'err')
    } finally {
      discoverBtn.disabled = false
    }
  }

  discoverBtn.addEventListener('click', () => discover(accountSelect.value || undefined))
  accountSelect.addEventListener('change', () => discover(accountSelect.value))

  completeBtn.addEventListener('click', async () => {
    const managementToken = mgmtInput.value.trim()
    const gatewayToken = cfutInput.value.trim()
    const gatewayId = gwSelect.value
    if (!gatewayToken) {
      setStatus('请粘贴 cfut_xxx（Gateway Token）', 'err')
      return
    }
    completeBtn.disabled = true
    setStatus('正在验证并保存…')
    try {
      const res = await _ctx.api('/api/onboarding/complete', {
        method: 'POST',
        body: { managementToken, accountId, gatewayId, gatewayToken },
      })
      renderDone(body, res)
    } catch (err) {
      const steps = err.body && Array.isArray(err.body.steps) ? err.body.steps : []
      setStatus([`初始化失败：${err.message}`, ...steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step}：${s.message}`)].join('\n'), 'err')
    } finally {
      completeBtn.disabled = false
    }
  })
}

/** 渲染完成页 */
function renderDone(body, res) {
  body.innerHTML = ''
  body.append(el('h3', 'onboarding-done-title', '初始化完成 ✓'))
  const ul = el('ul', 'onboarding-steps')
  for (const s of Array.isArray(res.steps) ? res.steps : []) {
    ul.append(el('li', s.ok ? 'ok' : 'warn', `${s.ok ? '✓' : '⚠'} ${s.step}：${s.message}`))
  }
  body.append(ul)
  if (Array.isArray(res.warnings) && res.warnings.length) {
    body.append(el('p', 'onboarding-note', res.warnings.join('；')))
  }
  const actions = el('div', 'onboarding-actions')
  const enter = button('进入管理界面', { primary: true })
  enter.addEventListener('click', () => {
    hideOverlay()
    // 重新加载以拉取完整账户状态（视图状态已缓存旧值）
    if (typeof location !== 'undefined' && location.reload) location.reload()
  })
  actions.append(enter)
  body.append(actions)
}

// ─── 对外入口 ────────────────────────────────────────────

/**
 * 打开引导浮层（可强制）
 * @param {{ force?: boolean, api?: Function }} [opts] - api 为 app.js 注入的请求函数
 */
export function openOnboarding(opts = {}) {
  const root = overlayEl()
  if (!root) return
  _ctx = { ...(_ctx || {}), ...(opts.api ? { api: opts.api } : {}) }
  const body = root.querySelector('#onboarding-body')
  if (body) renderChoose(body)
  showOverlay()
}

/** 关闭引导浮层（不改变任何配置，用于「稍后配置」） */
export function closeOnboarding() {
  hideOverlay()
}

/**
 * 初始化引导：拉账户状态，未初始化则自动显示
 * @param {object} opts
 * @param {Function} opts.api - app.js 的 api() 请求函数（注入避免循环依赖）
 * @returns {Promise<boolean>} 是否进入了引导
 */
export async function initOnboarding({ api } = {}) {
  if (typeof document === 'undefined') return false
  const root = overlayEl()
  if (!root || typeof api !== 'function') return false

  const body = root.querySelector('#onboarding-body')
  const later = root.querySelector('#onboarding-later')
  if (later && !later.dataset.bound) {
    later.dataset.bound = '1'
    later.addEventListener('click', () => closeOnboarding())
  }

  let status = null
  try {
    status = await api('/api/account/status')
  } catch {
    return false // 拉取失败：不打扰，保持正常界面
  }

  _ctx = { api, status }
  if (!isOnboardingNeeded(status)) return false

  if (body) renderChoose(body)
  showOverlay()
  return true
}
