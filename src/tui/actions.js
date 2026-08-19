/**
 * TUI 动作 — 纯状态操作，无 UI 依赖
 *
 * 按键触发的状态变更逻辑集中于此，便于单测与复用。
 * 所有函数返回是否发生了变更（dirty），由调用方决定是否刷新 UI。
 *
 * @module ai-gateway-desk/src/tui/actions
 */

import { removeModel, saveState as saveStateImpl } from '../core/state.js'
import { writeModelsJson as writeModelsJsonImpl } from '../output/generate.js'
import { deployToKV as deployToKVImpl } from '../output/deploy.js'
import { syncProviders } from '../cloudflare/providers-sync.js'
import { gatewaySlug } from '../cloudflare/discover.js'

/**
 * space：切换 selected ↔ hidden
 * @param {object} state
 * @param {string} modelId
 * @returns {boolean} 是否发生变更
 */
export function toggleStatus(state, modelId) {
  const entry = state[modelId]
  if (!entry) return false

  if (entry.status === 'selected') {
    entry.status = 'hidden'
  } else if (entry.status === 'hidden') {
    entry.status = 'selected'
  } else {
    return false
  }
  return true
}

/**
 * d：一次性永久删除（无论是否已标记 removed，直接删除条目）
 * @param {object} state
 * @param {string} modelId
 * @returns {boolean} 是否发生变更
 */
export function markRemovedOrDelete(state, modelId) {
  if (!state[modelId]) return false
  removeModel(state, modelId)
  return true
}

/**
 * F2：批量切换（有选中 → 全部隐藏；无选中 → 全部选中）
 * @param {object} state
 * @param {string[]} [modelIds] - 仅切换这些模型（筛选结果）；缺省 = 全部模型。
 *   removed 状态的模型始终不参与切换。
 * @returns {boolean} 是否发生变更
 */
export function toggleAllStatus(state, modelIds) {
  const ids = Array.isArray(modelIds) ? modelIds : Object.keys(state)
  const targets = ids.filter((id) => state[id] && state[id].status !== 'removed')
  const currentSelected = targets.filter((id) => state[id].status === 'selected').length
  const targetStatus = currentSelected > 0 ? 'hidden' : 'selected'
  for (const id of targets) {
    state[id].status = targetStatus
  }
  return targets.length > 0
}

/**
 * provider 同步步骤：拉取云端 provider 合并写回 providers.json，并更新内存 config
 *
 * 任务 15：u 同步前先自动拉取云端 provider 列表，解决「dashboard 手动添加
 * provider 后，本地 u 发现不了新 provider」的最后一公里。
 *
 * 注意：syncFn（默认 syncProviders）内部已写回 providers.json 文件，
 * 本函数只负责把返回的 result.providers 赋给 config.providers（内存就地替换，
 * 不重新 loadConfig——全新环境文件可能缺 gateway/kv，重新 loadConfig 会校验抛错）。
 *
 * @param {object} config - 当前配置（成功后 config.providers 被就地替换）
 * @param {string} apiToken - 管理 API Token
 * @param {Function} [syncFn] - 同步函数，默认 syncProviders（测试可注入 mock）
 * @returns {Promise<{ ok: boolean, skipped?: boolean, result?: object, error?: Error }>}
 *   ok:true    → result = syncProviders 返回值（含 providers/newProviders/removedProviders/errors）
 *   ok:false   → error = 捕获的错误（网络 / API 失败），config 不变
 *   skipped:true → apiToken 为空，未调用 syncFn
 */
export async function syncProvidersToConfig(config, apiToken, syncFn = syncProviders) {
  if (!apiToken) {
    return { ok: false, skipped: true }
  }
  try {
    const result = await syncFn(config, apiToken)
    if (result && Array.isArray(result.providers)) {
      config.providers = result.providers
    }
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error }
  }
}
// ─── Provider 可见性：隐藏的 provider 其模型不展示（仅 UI 过滤，不删 state）───

/**
 * 从配置中收集被隐藏（enabled === false）的 provider 网关 slug 集合。
 * custom-provider 使用 gatewaySlug（custom- 前缀），与模型 id 的 provider 段一致。
 * @param {Array<object>} [providers] - config.providers
 * @returns {Set<string>}
 */
export function hiddenProviderSlugs(providers) {
  const set = new Set()
  for (const p of Array.isArray(providers) ? providers : []) {
    if (p && p.id && p.enabled === false) set.add(gatewaySlug(p))
  }
  return set
}

/**
 * 从 state 中剔除属于隐藏 provider 的条目（返回新对象，不修改入参）。
 * 仅作 UI 展示过滤；原始 state 与已部署 models.json 保持不变（重新显示可恢复）。
 * @param {object} state
 * @param {Set<string>|string[]} hiddenSlugs
 * @returns {object}
 */
export function filterVisibleState(state, hiddenSlugs) {
  const hidden = hiddenSlugs instanceof Set ? hiddenSlugs : new Set(hiddenSlugs || [])
  if (hidden.size === 0) return state
  const out = {}
  for (const [id, entry] of Object.entries(state)) {
    if (!hidden.has(entryProvider(entry))) out[id] = entry
  }
  return out
}


// ─── 任务 19：模型筛选（纯函数，不修改原 state）────────────────

/**
 * 取条目的 provider 标识（兼容顶层 provider 字段与 metadata.provider）
 * @param {object} entry
 * @returns {string|null}
 */
export function entryProvider(entry) {
  if (!entry) return null
  if (typeof entry.provider === 'string' && entry.provider) return entry.provider
  if (entry.metadata && typeof entry.metadata.provider === 'string' && entry.metadata.provider) {
    return entry.metadata.provider
  }
  return null
}

/**
 * 从 state 收集去重后的 provider 列表（供 P 筛选弹窗展示）
 * @param {object} state
 * @returns {string[]}
 */
export function collectProviders(state) {
  const set = new Set()
  for (const entry of Object.values(state)) {
    const p = entryProvider(entry)
    if (p) set.add(p)
  }
  return [...set].sort()
}

/**
 * 按 provider 筛选（纯函数，不修改原 state）
 * @param {object} state
 * @param {string} provider
 * @returns {Array<{ modelId: string, entry: object }>} 匹配条目（空数组 = 无匹配）
 */
export function filterModelsByProvider(state, provider) {
  if (!provider) return []
  return Object.entries(state)
    .filter(([, entry]) => entryProvider(entry) === provider)
    .map(([modelId, entry]) => ({ modelId, entry }))
}

/**
 * 按关键字筛选（纯函数，不修改原 state）
 * 对模型 id 与 metadata.name 做不区分大小写的模糊匹配。
 * @param {object} state
 * @param {string} keyword
 * @returns {Array<{ modelId: string, entry: object }>} 匹配条目（空数组 = 无匹配）
 */
export function filterModelsByKeyword(state, keyword) {
  if (!keyword) return []
  const kw = String(keyword).toLowerCase()
  return Object.entries(state)
    .filter(([modelId, entry]) => {
      const meta = entry.metadata || {}
      const name = typeof meta.name === 'string' ? meta.name : ''
      return modelId.toLowerCase().includes(kw) || name.toLowerCase().includes(kw)
    })
    .map(([modelId, entry]) => ({ modelId, entry }))
}

/**
 * 组合筛选（provider + keyword 叠加，交集）
 * @param {object} state
 * @param {{ provider: string|null, keyword: string|null }} filter
 * @returns {Array<{ modelId: string, entry: object }>}
 */
export function applyModelFilters(state, filter = {}) {
  const { provider = null, keyword = null, status = null } = filter
  let items = Object.entries(state).map(([modelId, entry]) => ({ modelId, entry }))
  if (provider) {
    items = items.filter(({ entry }) => entryProvider(entry) === provider)
  }
  if (keyword) {
    const kw = String(keyword).toLowerCase()
    items = items.filter(({ modelId, entry }) => {
      const meta = entry.metadata || {}
      const name = typeof meta.name === 'string' ? meta.name : ''
      return modelId.toLowerCase().includes(kw) || name.toLowerCase().includes(kw)
    })
  }
  if (status) {
    items = items.filter(({ entry }) => entry.status === status)
  }
  return items
}

// ─── 任务 19：保存并提交（三步串行，失败不回滚）────────────────

/**
 * 「保存并提交」编排：saveState → writeModelsJson → deployToKV，三步串行。
 * 每步成功才继续下一步；失败立即停止并返回失败步骤，已完成的步骤不回滚。
 *
 * 依赖以命名参数注入（默认绑定真实模块），测试可传 mock 验证步骤编排。
 *
 * @param {object} options
 * @param {object} options.state - model-states 对象
 * @param {object} options.config - loadConfig() 返回的配置（部署需要 kv.namespaceId）
 * @param {Function} [options.saveStateFn] - 第 1 步：写 data/model-states.json
 * @param {Function} [options.writeModelsJsonFn] - 第 2 步：生成 data/models.json
 * @param {Function} [options.deployToKVFn] - 第 3 步：wrangler 部署到 KV
 * @returns {Promise<{ ok: true } | { ok: false, step: 1|2|3, error: Error }>}
 */
export async function saveAndDeploy({
  state,
  config,
  saveStateFn = saveStateImpl,
  writeModelsJsonFn = writeModelsJsonImpl,
  deployToKVFn = deployToKVImpl,
}) {
  // 第 1 步：保存 state
  try {
    saveStateFn(state)
  } catch (error) {
    return { ok: false, step: 1, error }
  }

  // 第 2 步：生成 models.json
  try {
    writeModelsJsonFn(state)
  } catch (error) {
    return { ok: false, step: 2, error }
  }

  // 第 3 步：部署到 KV（deployToKV 失败返回 { success: false } 而非抛错，统一转 Error）
  try {
    const result = await deployToKVFn(config)
    if (!result || result.success !== true) {
      const output = (result && result.output) || '未知原因'
      return { ok: false, step: 3, error: new Error(output) }
    }
  } catch (error) {
    return { ok: false, step: 3, error }
  }

  return { ok: true }
}

// ─── 任务 26：编辑模型元数据（Web API 层复用）────────────────

/**
 * 编辑模型元数据（任务 26，Web API 层复用）。
 * 语义与 TUI showEditForm 完全一致：
 *   - fields 中 undefined / 空字符串的字段不覆盖（保留原值）
 *   - context_length：非空值 parseInt 转数字，NaN 忽略（不覆盖）
 *   - max_output_length：同上（非空值 parseInt 转数字，NaN 忽略）
 *   - name / description：非空字符串直接写
 * 原地修改 state（与 actions.js 其他函数一致）。
 * @param {object} state
 * @param {string} modelId
 * @param {{ name?: string, context_length?: number|string, max_output_length?: number|string, description?: string }} fields
 * @returns {boolean} 是否发生变更（模型不存在 / 无任何字段生效 → false）
 */
export function editModelMetadata(state, modelId, fields) {
  if (!fields || typeof fields !== 'object') return false
  const entry = state[modelId]
  if (!entry) return false

  const newMeta = { ...(entry.metadata || {}) }
  let changed = false

  if (fields.name !== undefined && fields.name !== '') {
    newMeta.name = fields.name
    changed = true
  }
  // context_length：非空值才 parseInt；NaN 忽略（不覆盖）；"0" 是合法值必须写入
  if (fields.context_length !== undefined && fields.context_length !== '') {
    const num = parseInt(fields.context_length, 10)
    if (!Number.isNaN(num)) {
      newMeta.context_length = num
      changed = true
    }
  }
  // max_output_length：非空值才 parseInt；NaN 忽略（不覆盖）；"0" 是合法值必须写入
  if (fields.max_output_length !== undefined && fields.max_output_length !== '') {
    const num = parseInt(fields.max_output_length, 10)
    if (!Number.isNaN(num)) {
      newMeta.max_output_length = num
      changed = true
    }
  }
  if (fields.description !== undefined && fields.description !== '') {
    newMeta.description = fields.description
    changed = true
  }

  if (changed) {
    entry.metadata = newMeta
  }
  return changed
}
