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
 * 将发现结果与现有 state 合并（策略 A：provider 覆盖）
 *
 * @param {object} state - model-states.json 的内容
 *   { modelId: { status: string, provider: string, metadata: object } }
 * @param {object} discoveryResults - discoverModels 的返回值
 *   { results: [{ provider: string, models: Array<object> }], errors: Array }
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

  // 收集成功被查询的 provider slug，只有这些 provider 下的模型才受「未发现→移除」规则
  const discoveredProviders = new Set(discoveryResults.results.map((r) => r.provider))

  // 遍历每个 provider 的模型列表
  for (const { provider, models } of discoveryResults.results) {
    for (const model of models) {
      const modelId = model.id
      discoveredIds.add(modelId)

      if (Object.prototype.hasOwnProperty.call(newState, modelId)) {
        // ---- 模型已存在 ----
        const entry = newState[modelId]

        // 如果之前是 removed，复活为 selected
        // 复活是真实变更（否则无计数 → 不落盘，重启后丢失），计入 updatedModels
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

  // 处理 state 中存在但本次发现没返回的模型
  // 注意：只对成功被查询的 provider 执行「未发现→移除」规则。
  // 如果 provider 不支持模型列表接口（如火山方舟），它的模型不应被标记为 removed。
  for (const [modelId, entry] of Object.entries(newState)) {
    if (!discoveredIds.has(modelId) && discoveredProviders.has(entry.provider)) {
      if (entry.status !== 'removed') {
        entry.status = 'removed'
        removedModels.push(modelId)
      }
    }
  }

  return {
    state: newState,
    newModels,
    removedModels,
    updatedModels,
  }
}
