/**
 * TUI 渲染纯函数（从 TUI views.js/keys.js 迁移，Web 测试继续使用）
 *
 * 任务 34：旧 TUI 依赖与 TUI 专属代码整体移除。原 src/tui/views.js 的
 * 7 个纯字符串渲染函数（buildFilterBar / buildListItems / buildTableHeader /
 * buildProviderSidebarItems / buildProviderItems / buildAccountLines /
 * buildWorkersLines，含内部 formatNumber）与 src/tui/keys.js 的 3 个视图常量
 * （VIEWS / VIEW_ORDER / VIEW_LABELS）原样迁移至此，函数签名与输出逐字节不变。
 * 原 views.js 依赖的终端 unicode 模块 strWidth 已内联（见下方 strWidth），
 * 本模块不依赖任何 blessed 终端库。
 */

import { collectProviders, entryProvider } from './actions.js'

/**
 * CJK 显示宽度（从原 TUI unicode 模块内联，删除终端库依赖后的替代）
 * CJK 统一表意文字主区及扩展区按 2 宽，其余按 1 宽。
 * @param {string} s
 * @returns {number}
 */
export function strWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const code = ch.codePointAt(0)
    // 常用 CJK 区段（含扩展 A/B、全角标点、假名、谚文）
    if (
      (code >= 0x1100 && code <= 0x115f) ||   // 谚文 Jamo
      (code >= 0x2e80 && code <= 0xa4cf) ||   // CJK 部首/扩展 A/假名/谚文音节
      (code >= 0xac00 && code <= 0xd7a3) ||   // 谚文音节
      (code >= 0xf900 && code <= 0xfaff) ||   // CJK 兼容表意文字
      (code >= 0xfe30 && code <= 0xfe4f) ||   // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) ||   // 全角形式
      (code >= 0xffe0 && code <= 0xffe6) ||   // 全角符号
      (code >= 0x20000 && code <= 0x2fffd)    // CJK 扩展 B+
    ) {
      w += 2
    } else {
      w += 1
    }
  }
  return w
}

// ─── 任务 24：模型表格（列宽 / 截断 / 填充，CJK 双宽安全）────

/**
 * 表格列宽分配：状态列固定，上下文列与输出列固定，Provider 列取中，模型 ID 列占余量
 * @param {number} width - 表格可用显示宽度
 * @returns {{ idW: number, providerW: number, ctxW: number, outW: number, statusW: number }}
 */
function tableColumns(width) {
  const statusW = 6 // 「◉ 选中」= 图标1 + 空格1 + 2 个 CJK(4)
  const ctxW = 6    // 「上下文」（128K 右对齐）
  const outW = 4    // 「输出」（4K 右对齐）
  const providerW = Math.max(6, Math.min(12, Math.floor((width - 4 - ctxW - outW - statusW) / 2)))
  const idW = Math.max(6, width - 1 - providerW - 1 - ctxW - 1 - outW - 1 - statusW)
  return { idW, providerW, ctxW, outW, statusW }
}

/**
 * 按显示宽度截断文本（CJK 双宽安全），超出时末尾补省略号
 * @param {string} text
 * @param {number} maxWidth
 * @returns {string}
 */
function truncateWidth(text, maxWidth) {
  const plain = String(text)
  if (strWidth(plain) <= maxWidth) return plain
  let out = ''
  for (const ch of plain) {
    if (strWidth(out) + strWidth(ch) > maxWidth - 1) break
    out += ch
  }
  return out + '…'
}

/**
 * 右侧填充至指定显示宽度（blessed 标签不计宽，适合已带标签的单元格）
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function padWidth(text, width) {
  const plain = String(text).replace(/\{[^}]*\}/g, '')
  return text + ' '.repeat(Math.max(0, width - strWidth(plain)))
}

/**
 * 左侧填充至指定显示宽度（右对齐）
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function padLeft(text, width) {
  const plain = String(text).replace(/\{[^}]*\}/g, '')
  return ' '.repeat(Math.max(0, width - strWidth(plain))) + text
}

/**
 * 将 state 转为表格行数组，每项包含显示文本和模型 id
 *
 * 表格列：模型ID（弹性，截断）| Provider | 上下文（右对齐）| 输出（右对齐）| 状态（◉ 选中 / ○ 隐藏）
 *
 * @param {object} state
 * @param {number} [width=60] - 表格可用显示宽度
 * @returns {Array<{ text: string, modelId: string, entry: object }>}
 */
export function buildListItems(state, width = 60) {
  const { idW, providerW, ctxW, outW, statusW } = tableColumns(width)
  const items = []
  // 按状态分组：selected > hidden，组内按 id 排序
  const sorted = Object.entries(state).sort((a, b) => {
    const order = { selected: 0, hidden: 1 }
    const oa = order[a[1].status] ?? 99
    const ob = order[b[1].status] ?? 99
    if (oa !== ob) return oa - ob
    return a[0].localeCompare(b[0])
  })

  for (const [modelId, entry] of sorted) {
    const meta = entry.metadata || {}
    const statusText = entry.status === 'selected'
      ? '{green-fg}◉{/green-fg} 选中'
      : '{yellow-fg}○{/yellow-fg} 隐藏'

    const ctx = meta.context_length ? formatNumber(meta.context_length) : ''
    const out = meta.max_output_length ? formatNumber(meta.max_output_length) : ''
    const provider = entryProvider(entry) || ''

    const idCell = `{bold}${padWidth(truncateWidth(modelId, idW), idW)}{/bold}`
    const providerCell = padWidth(truncateWidth(provider, providerW), providerW)
    const ctxCell = padLeft(ctx, ctxW)
    const outCell = padLeft(out, outW)
    const statusCell = padWidth(statusText, statusW)

    items.push({
      text: `${idCell} ${providerCell} ${ctxCell} ${outCell} ${statusCell}`,
      modelId,
      entry,
    })
  }
  return items
}

/**
 * 构建表格表头行（与 buildListItems 列宽一致，保证对齐）
 * @param {number} [width=60]
 * @returns {string} blessed tags 内容
 */
export function buildTableHeader(width = 60) {
  const { idW, providerW, ctxW, outW, statusW } = tableColumns(width)
  const idCell = padWidth('模型ID', idW)
  const providerCell = padWidth('Provider', providerW)
  const ctxCell = padWidth('上下文', ctxW)
  const outCell = padWidth('输出', outW)
  const statusCell = padWidth('状态', statusW)
  return `{bold}${idCell} ${providerCell} ${ctxCell} ${outCell} ${statusCell}{/bold}`
}

/**
 * 构建左侧 Provider 侧栏条目（第一项「全部」，其余按 id 排序）
 *
 * 每条格式：` provider …计数`（计数为模型总数，右对齐 2 位）
 *
 * @param {object} state
 * @param {number} [width=16] - 侧栏显示宽度
 * @returns {Array<{ text: string, provider: string|null, count: number }>}
 *   provider 为 null 表示「全部」条目
 */
export function buildProviderSidebarItems(state, width = 16) {
  const inner = width - 4 // 前缀1空格 + 分隔1空格 + 计数2
  const countAll = (entries) => entries.length
  const list = [
    { provider: null, count: countAll(Object.values(state)) },
    ...collectProviders(state).map((p) => ({
      provider: p,
      count: countAll(Object.values(state).filter((e) => entryProvider(e) === p)),
    })),
  ]
  for (const item of list) {
    const label = item.provider === null ? '全部' : item.provider
    const labelCell = padWidth(truncateWidth(label, inner), inner)
    const countCell = String(item.count).padStart(2, ' ')
    item.text = ` ${labelCell} ${countCell}`
  }
  return list
}

/**
 * 数字格式化（K / M 缩写）
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K'
  return String(n)
}

// ─── 任务 19：筛选相关视图组件 ────────────────────────────

/**
 * 构建筛选状态栏文本（列表顶部显示）
 * @param {{ provider: string|null, keyword: string|null }} filter
 * @returns {string|null} blessed tags 内容；无筛选时返回 null
 */
export function buildFilterBar(filter = {}) {
  const parts = []
  if (filter.provider) parts.push(`provider=${filter.provider}`)
  if (filter.keyword) parts.push(`关键字=${filter.keyword}`)
  if (parts.length === 0) return null
  return ` {cyan-fg}筛选:{/cyan-fg} ${parts.join('  |  ')}  {gray-fg}(ESC 清除){/gray-fg}`
}

// ─── 任务 20：Provider 视图组件 ──────────────────────────

/**
 * 将合并展示的 provider 数组转为列表项（Provider 视图用）
 *
 * 列表项格式：状态图标 + slug + name + type + 本地 enabled + 云端标记。
 * mark: 'new' → `{新增}`（黄）/ 'removed' → `{云端已删}`（红）/ 其他不显示
 *
 * @param {Array<{ id, name, type, enabled, mark }>} providers
 * @returns {Array<{ text: string, provider: object }>}
 */
export function buildProviderItems(providers) {
  const items = []
  // 排序：新增/云端已删标记优先展示，其余按 id
  const sorted = [...providers].sort((a, b) => {
    const order = { new: 0, removed: 1, null: 2 }
    const oa = order[a.mark ?? 'null'] ?? 2
    const ob = order[b.mark ?? 'null'] ?? 2
    if (oa !== ob) return oa - ob
    return String(a.id).localeCompare(String(b.id))
  })

  for (const p of sorted) {
    const enabledMark = p.enabled !== false
      ? '{green-fg}启用{/green-fg}'
      : '{gray-fg}停用{/gray-fg}'
    const typeText = p.type === 'custom-provider'
      ? '{cyan-fg}custom{/cyan-fg}'
      : '{yellow-fg}byok{/yellow-fg}'
    const markText = p.mark === 'new'
      ? ' {yellow-fg}[新增]{/yellow-fg}'
      : p.mark === 'removed'
        ? ' {red-fg}[云端已删]{/red-fg}'
        : ''
    const nameText = p.name ? ` {gray-fg}${p.name}{/gray-fg}` : ''
    items.push({
      text: ` {bold}${p.id}{/bold}${nameText}  ${typeText}  ${enabledMark}${markText}`,
      provider: p,
    })
  }
  return items
}

// ─── 任务 21：账户视图 / Worker 视图组件 ────────────────

/**
 * 账户视图状态面板行（[4] 账户：双 token 槽位 + gateway 信息）
 *
 * 输入由 account-actions.js summarizeTokenStatus / summarizeGatewayInfo 提供。
 * 每行格式（含 blessed tags）：
 *   管理 API Token: ● 本地已存   （source=local）
 *   Gateway Token:  ● env 提供   （source=env）
 *   accountId / gatewayId（缺失显示「未配置」）
 *
 * @param {object} summary
 * @param {{ source: string, hasLocal: boolean, label: string, mark: string }} summary.management
 * @param {{ source: string, hasLocal: boolean, label: string, mark: string }} summary.gateway
 * @param {{ accountId: string, gatewayId: string }} summary.gatewayInfo
 * @returns {string[]} 面板行（含标题行）
 */
export function buildAccountLines(summary) {
  const slotLine = (label, s) => {
    const icon = s.mark === '●'
      ? '{green-fg}●{/green-fg}'
      : '{red-fg}○{/red-fg}'
    const extra = s.source === 'env' && s.hasLocal
      ? ' {gray-fg}(本地也有存量){/gray-fg}'
      : ''
    return ` {bold}${label}:{/bold} ${icon} ${s.label}${extra}`
  }

  const g = summary.gatewayInfo || {}
  return [
    ' {bold}{cyan-fg}凭证槽位{/cyan-fg}{/bold}',
    slotLine('管理 API Token', summary.management),
    slotLine('Gateway Token', summary.gateway),
    '',
    ' {bold}{cyan-fg}Gateway 信息{/cyan-fg}{/bold}',
    ` accountId: ${g.accountId}`,
    ` gatewayId: ${g.gatewayId}`,
    '',
    ' {gray-fg}1/2 更新   3/4 清除（清除前确认影响面）{/gray-fg}',
  ]
}

/**
 * Worker 视图状态面板行（[3] Worker：KV / models.json / KV key + 部署提示）
 *
 * 输入由 account-actions.js buildWorkersStatus 提供。
 *
 * @param {object} status
 * @param {{ configured: boolean, id: string }} status.kvNamespace
 * @param {{ exists: boolean, count: number|null }} status.modelsJson
 * @param {{ status: string, detail: string }} status.kvKey
 * @param {boolean} status.canDeploy
 * @returns {string[]} 面板行（含标题行）
 */
export function buildWorkersLines(status) {
  const kvLine = status.kvNamespace.configured
    ? ` {bold}KV namespace id:{/bold} {green-fg}${status.kvNamespace.id}{/green-fg}`
    : ' {bold}KV namespace id:{/bold} {yellow-fg}未配置（账户视图 i 初始化）{/yellow-fg}'

  const mj = status.modelsJson
  const modelsLine = mj.exists
    ? ` {bold}data/models.json:{/bold} {green-fg}存在{/green-fg}${mj.count !== null ? ` {gray-fg}(${mj.count} 个模型){/gray-fg}` : ''}`
    : ' {bold}data/models.json:{/bold} {yellow-fg}不存在（按 S 保存并提交生成）{/yellow-fg}'

  const keyLine = status.kvKey.status === 'exists'
    ? ` {bold}KV key "models":{/bold} {green-fg}${status.kvKey.detail}{/green-fg}`
    : status.kvKey.status === 'error'
      ? ` {bold}KV key "models":{/bold} {red-fg}${status.kvKey.detail}{/red-fg}`
      : ` {bold}KV key "models":{/bold} {gray-fg}${status.kvKey.detail}{/gray-fg}`

  return [
    ' {bold}{cyan-fg}部署状态{/cyan-fg}{/bold}',
    kvLine,
    modelsLine,
    keyLine,
    '',
    ' {gray-fg}Worker 代码无需修改，此视图仅管理部署{/gray-fg}',
    status.canDeploy
      ? ' {bold}D{/bold}: 部署 Worker（wrangler deploy，生成临时配置）'
      : ' {yellow-fg}部署不可用：先配置 KV namespace（账户视图 i 初始化）{/yellow-fg}',
  ]
}

// ─── 视图标识（从 keys.js 迁移）─────────────────────────

export const VIEWS = Object.freeze({
  PROVIDERS: 'providers',
  MODELS: 'models',
  WORKERS: 'workers',
  ACCOUNT: 'account',
})

// 视图在选项卡中的展示顺序
export const VIEW_ORDER = Object.freeze([
  VIEWS.PROVIDERS,
  VIEWS.MODELS,
  VIEWS.WORKERS,
  VIEWS.ACCOUNT,
])

// 视图展示名（选项卡 / 提示栏用）
export const VIEW_LABELS = Object.freeze({
  [VIEWS.PROVIDERS]: 'Provider',
  [VIEWS.MODELS]: '模型',
  [VIEWS.WORKERS]: 'Worker',
  [VIEWS.ACCOUNT]: '账户',
})
