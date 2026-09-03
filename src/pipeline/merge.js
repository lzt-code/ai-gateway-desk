/**
 * 状态合并模块 — 将发现结果与现有 state 合并，执行策略 A（provider 覆盖）
 * @module ai-gateway-desk/src/pipeline/merge
 */

/**
 * 比较/合并时应忽略的字段（不影响「是否有真实更新」的判定）：
 *   - id：冗余字段（与 state 的 key 重复），缺失时自动补全不应视为更新
 *   - created：部分上游（如 OpenCode）每次请求都返回当前时间戳，
 *     时间戳变化不代表模型本身有更新，否则每次同步都会误报更新
 * @type {string[]}
 */
const VOLATILE_METADATA_FIELDS = ['id', 'created']

/**
 * 比较两个 metadata 对象是否有差异（浅比较）
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function hasMetadataChanged(a, b) {
  const filterVolatile = (obj) => {
    if (!obj || typeof obj !== 'object') return obj
    const rest = { ...obj }
    for (const field of VOLATILE_METADATA_FIELDS) {
      delete rest[field]
    }
    return rest
  }
  const fa = filterVolatile(a)
  const fb = filterVolatile(b)
  const keysA = Object.keys(fa)
  const keysB = Object.keys(fb)
  if (keysA.length !== keysB.length) return true
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(fb, key)) return true
    if (JSON.stringify(fa[key]) !== JSON.stringify(fb[key])) return true
  }
  return false
}

/**
 * 计算两个 metadata 对象的字段级差异（忽略易变字段 id/created）
 * @param {object} oldMeta
 * @param {object} newMeta
 * @returns {Array<{ field: string, oldValue: any, newValue: any }>}
 */
export function diffMetadata(oldMeta, newMeta) {
  const a = oldMeta && typeof oldMeta === 'object' ? oldMeta : {}
  const b = newMeta && typeof newMeta === 'object' ? newMeta : {}
  const keys = new Set(
    [...Object.keys(a), ...Object.keys(b)].filter((k) => !VOLATILE_METADATA_FIELDS.includes(k))
  )
  const changes = []
  for (const k of keys) {
    const ov = a[k]
    const nv = b[k]
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      changes.push({ field: k, oldValue: ov, newValue: nv })
    }
  }
  return changes
}

/**
 * 基于同步前后的 state 与 summary 构建「调试模式同步变更明细」
 * 供 sync-flow 与 server 下发给前端表格展示：
 *   added: 本次新增模型（modelId/provider/metadata/status）
 *   removed: 本次删除模型（来源为旧 state）
 *   updated: 本次更新模型，每项含字段级 changes（含 status/provider/manual + metadata 差异）
 * @param {object} oldState - 同步前的 state 浅拷贝（原对象，不会被修改）
 * @param {object} newState - 同步后（含 enrich）的 state
 * @param {{ newModels: string[], removedModels: string[], updatedModels: string[] }} summary
 * @returns {{ added: Array, removed: Array, updated: Array }}
 */
export function buildSyncDetails(oldState, newState, summary) {
  const s = summary || { newModels: [], removedModels: [], updatedModels: [] }
  const added = (s.newModels || []).map((modelId) => {
    const e = newState[modelId] || {}
    return { modelId, provider: e.provider || null, metadata: e.metadata || {}, status: e.status || null }
  })
  const removed = (s.removedModels || []).map((modelId) => {
    const e = oldState[modelId] || {}
    return { modelId, provider: e.provider || null, metadata: e.metadata || {}, status: e.status || null }
  })
  const updated = (s.updatedModels || []).map((modelId) => {
    const oldE = oldState[modelId] || {}
    const newE = newState[modelId] || {}
    const changes = []
    if (oldE.status !== newE.status) changes.push({ field: 'status', oldValue: oldE.status, newValue: newE.status })
    if (oldE.provider !== newE.provider) changes.push({ field: 'provider', oldValue: oldE.provider, newValue: newE.provider })
    const oldManual = !!oldE.manual
    const newManual = !!newE.manual
    if (oldManual !== newManual) changes.push({ field: 'manual', oldValue: oldManual, newValue: newManual })
    changes.push(...diffMetadata(oldE.metadata, newE.metadata))
    return { modelId, provider: newE.provider || oldE.provider || null, changes }
  }).filter((u) => u.changes.length > 0)
  return { added, removed, updated }
}

/**
 * 将发现结果与现有 state 合并（策略 A：provider 覆盖）
 *
 * 消失的模型（provider 不再返回）直接从 state 物理删除，不保留 removed 中间态；
 * 手工添加的模型（entry.manual）豁免。hidden 状态跨同步保持不变.
 *
 * @param {object} state - model-states.json 的内容
 *   { modelId: { status: string, provider: string, metadata: object } }
 * @param {object} discoveryResults - discoverModels 的返回值
 *   { results: [{ provider: string, models: Array<object> }], errors: Array }
 * @returns {{
 *   state: object,
 *   newModels: string[],
 * @returns {{
 *   state: object,
 *   newModels: string[],
 *   removedModels: string[],
 *   updatedModels: string[]
 * }}
 */
export function mergeDiscovery(state, discoveryResults) {
  // 深度克隆 state，不修改原对象
  const newState = structuredClone(state)

  const newModels = []
  const removedModels = []
  const updatedModels = []

  // 收集本次发现中所有出现的模型 id（用于后面找消失的模型）
  const discoveredIds = new Set()

  // 收集成功被查询的 provider slug，只有这些 provider 下的模型才受「未发现→删除」规则
  const discoveredProviders = new Set(discoveryResults.results.map((r) => r.provider))

  // 遍历每个 provider 的模型列表
  for (const { provider, models } of discoveryResults.results) {
    for (const model of models) {
      const modelId = model.id
      discoveredIds.add(modelId)

      if (Object.prototype.hasOwnProperty.call(newState, modelId)) {
        // ---- 模型已存在 ----
        const entry = newState[modelId]

        // 旧版 removed 中间态已废弃：存量条目直接归位 selected（真实变更，计入 updatedModels，
        // 否则无计数 → 不落盘，重启后丢失）
        if (entry.status === 'removed') {
          entry.status = 'selected'
          if (!updatedModels.includes(modelId)) {
            updatedModels.push(modelId)
          }
        }

        // 策略 A：provider 返回的字段覆盖 metadata
        // 只覆盖 provider 返回了的字段，没返回的保留原值；
        // 易变字段（id/created）不回写，保证「无变化」时内存态与磁盘完全一致，
        // 否则前端拉到新时间戳会误判为未保存（created 保持首次发现值）
        const oldMetadata = { ...entry.metadata }
        for (const [key, value] of Object.entries(model)) {
          if (VOLATILE_METADATA_FIELDS.includes(key)) continue
          entry.metadata[key] = value
        }

        // 检查 metadata 是否有变化
        if (hasMetadataChanged(oldMetadata, entry.metadata)) {
          if (!updatedModels.includes(modelId)) {
            updatedModels.push(modelId)
          }
        }

        // provider 不返回 name 但 metadata 有 name：触发 re-enrich 以补全
        // OpenRouter/models.dev 可能新增的富化字段。enrich 对已有字段不覆盖
        // （fill-only），因此不会产生无变化更新，仅填充缺失字段。
        if (
          !Object.prototype.hasOwnProperty.call(model, 'name') &&
          entry.metadata.name !== undefined &&
          !updatedModels.includes(modelId)
        ) {
          updatedModels.push(modelId)
        }
      } else {
        // ---- 新模型 ----
        newState[modelId] = {
          status: 'selected',
          provider,
          metadata: { ...model },
        }
        newModels.push(modelId)
      }
    }
  }

  // 处理 state 中存在但本次发现没返回的模型：直接物理删除（不做 removed 中间态）
  // 注意：只对成功被查询的 provider 执行「未发现→删除」规则。
  // 如果 provider 不支持模型列表接口（如火山方舟），它的模型不应被删除。
  // 手工添加的模型（entry.manual === true）跳过自动删除，避免因上游 /models 不完整而被误删
  for (const modelId of Object.keys(newState)) {
    const entry = newState[modelId]
    if (entry.manual) continue
    if (!discoveredIds.has(modelId) && discoveredProviders.has(entry.provider)) {
      delete newState[modelId]
      removedModels.push(modelId)
    }
  }

  return {
    state: newState,
    newModels,
    removedModels,
    updatedModels,
  }
}
