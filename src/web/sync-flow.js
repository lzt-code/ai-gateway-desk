/**
 * 任务 27：同步流程编排（runSyncFlow 纯函数）
 *
 * provider 同步 → discover → merge → enrich 四步编排，供 Web API 层复用。
 * 纯函数：不碰文件系统、不读 env、不弹 UI；一切依赖经 deps 注入，
 * 进度事件经 onEvent 回调外发（server.js 转发为 SSE）。
 *
 * 语义与原 TUI 同步流程（任务 15/27）完全一致：
 *   - provider 同步失败不中断 discover（管理 Token 缺失则跳过）
 *   - discover 无结果不抛错（summary 为空 + errors 携带原因）
 *   - enrich 失败静默跳过（enrichModel 内部已容错，这里兜底）
 *   - merge 用 structuredClone 深拷贝，原 state 对象不被修改
 *
 * @module ai-gateway-desk/src/web/sync-flow
 */

import { syncProvidersToConfig as syncProvidersToConfigImpl } from '../tui/actions.js'
import { discoverModels as discoverModelsImpl } from '../cloudflare/discover.js'
import { mergeDiscovery as mergeDiscoveryImpl, buildSyncDetails as buildSyncDetailsImpl } from '../pipeline/merge.js'
import { enrichModel as enrichModelImpl } from '../pipeline/enrich.js'

/**
 * 同步流程编排（任务 27）：provider 同步 → discover → merge → enrich
 * 纯函数：不碰文件系统、不读 env、不弹 UI；一切依赖经 deps 注入。
 * @param {object} options
 * @param {object} options.config - loadConfig() 的结果（含 gateway + providers）
 * @param {string} options.gatewayToken - cfut_xxx
 * @param {string} [options.mgmtToken] - 管理 Token（可空，空则跳过 provider 同步）
 * @param {object} options.state - 当前 model-states 对象（会被合并出新对象，原对象不修改）
 * @param {string} [options.providerFilter] - 可选：只拉取指定 provider（网关 slug）。
 *   传入时跳过 provider 同步步（不重拉云端 provider 列表），仅 discover 该 provider → merge → enrich。
 *   merge 的「未发现→删除」规则只作用于该 provider，其他 provider 的模型原样保留（见 merge.js discoveredProviders 限定）。
 * @param {object} [options.deps] - 依赖覆盖，字段：syncProvidersToConfig / discoverModels /
 *                                  mergeDiscovery / enrichModel（缺省绑定真实模块）
 * @param {(event: object) => void} [options.onEvent] - 进度事件回调（SSE 转发）
 *    事件对象：{ type: 'phase', phase: 'provider-sync'|'discover'|'enrich' }
 *            | { type: 'discover', ...onProgress 载荷 }（status:
 *              'pending'|'done'|'error'|'debug'；debug 事件为 /models 调用详情，
 *              仅 config.debug === true 时产生，见 discover.js）
 *            | { type: 'enrich', enriched: number, total: number }
 *            | { type: 'provider-sync', ok: boolean, message?: string, skipped?: boolean,
 *                newProviders?: string[], removedProviders?: string[],
 *                errors?: Array<{source,message}> }（新增/移除明细供前端逐条日志）
 * @returns {Promise<{
 *   state: object,          // 合并+富化后的新 state（无结果时返回原 state）
 *   summary: { newModels: string[], updatedModels: string[], removedModels: string[],
 *              errors: Array<{provider,error}> }
 *   // updatedModels 仅含「真实更新」：merge 改了 entry（status/metadata）或 enrich 改了
 *   // metadata 的模型。name 补救检查（provider 不返回 name 但 metadata 已有 name）
 *   // 触发的 re-enrich 候选若无实际变化不计入，避免每次同步都误报→不必要的 KV 部署。
 *   details: { added: Array, removed: Array, updated: Array<{ modelId, provider, changes: Array<{ field, oldValue, newValue }> }> }
 *   // 调试模式同步变更明细（表格展示）：哪些模型新增/删除/字段变化；details 为空表即无变更
 *   providerSync: { ok: boolean, skipped?: boolean, message?: string }
 * }>}
 */
export async function runSyncFlow({
  config,
  gatewayToken,
  mgmtToken,
  state,
  visibilityMap = null,
  providerFilter = null,
  deps = {},
  onEvent,
}) {
  const applyVisibility = deps.applyVisibility || ((providers) => providers) // 默认由 server 注入
  const emit = onEvent || (() => {})
  const {
    syncProvidersToConfig = syncProvidersToConfigImpl,
    discoverModels = discoverModelsImpl,
    mergeDiscovery = mergeDiscoveryImpl,
    enrichModel = enrichModelImpl,
    buildSyncDetails = buildSyncDetailsImpl,
  } = deps

  const providerSync = { ok: true }

  // 1. provider 同步（单 Provider 刷新时跳过：不重拉云端 provider 列表，直接进入 discover）
  //    语义：providerFilter 模式是「只刷新这一个 provider 的模型」，不需要也不应触碰 provider 列表
  if (!providerFilter) {
    emit({ type: 'phase', phase: 'provider-sync' })
    if (mgmtToken) {
      const r = await syncProvidersToConfig(config, mgmtToken)
      if (r.ok) {
        const newProviders = Array.isArray(r.result?.newProviders) ? r.result.newProviders : []
        const removedProviders = Array.isArray(r.result?.removedProviders) ? r.result.removedProviders : []
        // errors 为 [{ source, error: Error }]，SSE JSON 序列化会丢 Error.message，转字符串
        const errors = (r.result?.errors ?? []).map((e) => ({
          source: e.source,
          message: e.error instanceof Error ? e.error.message : String(e.error ?? '未知错误'),
        }))
        providerSync.ok = true
        providerSync.message = `新增 ${newProviders.length} / 移除 ${removedProviders.length}`
        emit({
          type: 'provider-sync',
          ok: true,
          message: providerSync.message,
          newProviders,
          removedProviders,
          errors,
        })
      } else {
        providerSync.ok = false
        providerSync.message = r.error?.message || 'provider 同步失败'
        emit({ type: 'provider-sync', ok: false, message: providerSync.message })
      }
    } else {
      providerSync.ok = false
      providerSync.skipped = true
      emit({ type: 'provider-sync', ok: false, skipped: true })
    }
  }

  // 2. 发现模型（onProgress 载荷原样透传）
  // 以 KV 可见性覆盖 config.providers 的 enabled，使隐藏的 provider 不参与发现
  emit({ type: 'phase', phase: 'discover' })
  const discoverConfig = {
    ...config,
    providers: applyVisibility(Array.isArray(config.providers) ? config.providers : [], visibilityMap),
  }
  const discovery = await discoverModels(discoverConfig, gatewayToken, (p) => {
    emit({ type: 'discover', ...p })
  }, providerFilter, mgmtToken)

  // 无结果：不抛错，返回空汇总（errors 携带失败原因，与 TUI「未发现任何模型」一致）
  if (discovery.results.length === 0) {
    return {
      state,
      summary: {
        newModels: [],
        updatedModels: [],
        removedModels: [],
        errors: discovery.errors,
      },
      details: { added: [], removed: [], updated: [] },
      providerSync,
    }
  }

  // 3. 合并（策略 A：provider 覆盖，消失模型直接删除）+ 富化新模型
  emit({ type: 'phase', phase: 'enrich' })
  const merged = mergeDiscovery(state, discovery)
  // 新模型 + 已更新模型都执行 enrich：
  //   - 新模型：补全缺失字段
  //   - 已更新模型：重新匹配，修正历史错误富化（如 matchModel bug 导致的误匹配）
  const enrichIds = [...merged.newModels, ...merged.updatedModels]
    // 动态路由（dynamic/ 前缀）跳过 enrich：路由名即展示名，不能被
    // OpenRouter 同名模型的显示名覆盖（如 glm-5.3-flash → "Z.ai: GLM 5.3 Flash"）
    .filter((modelId) => !modelId.startsWith('dynamic/'))
  // 存量回填：历史上因匹配失败（如双前缀 id）或上游别名字段导致 context_length
  // 一直缺失的老模型，不在 new/updated 里，常规同步永远跳过 enrich。
  // 本次将其纳入 enrich（匹配逻辑已修复 + 别名已归一化），一次同步即可回填。
  const enrichSet = new Set(enrichIds)
  const backfillIds = []
  for (const [modelId, entry] of Object.entries(merged.state)) {
    if (modelId.startsWith('dynamic/')) continue
    if (enrichSet.has(modelId)) continue
    if (entry?.manual) continue
    const m = entry?.metadata
    if (m && typeof m === 'object' && m.context_length == null) {
      backfillIds.push(modelId)
      enrichSet.add(modelId)
    }
  }
  const allEnrichIds = [...enrichIds, ...backfillIds]
  const total = allEnrichIds.length
  let enriched = 0

  // 区分「真实更新」与「name 补救检查触发的 re-enrich 候选」：
  // merge 的 updatedModels 含 name 补救误报（provider 不返回 name 但 metadata 已有
  // name → 标记 updated 以触发 re-enrich 修正历史误匹配）。这些模型若无实际 metadata
  // 变化不应计入 hasChanges，否则每次同步都误报「有更新」→ 不必要的 KV 部署。
  // 真实更新 = merge 改了 entry（status/metadata）OR enrich 改了 metadata。
  // 回填模型（backfillIds）同理：enrich 实际补上字段才计入，否则 state 不落盘、
  // 用户下次同步看到的还是缺失。
  const updatedSet = new Set(merged.updatedModels)
  const trackSet = new Set([...updatedSet, ...backfillIds])
  const realUpdatedSet = new Set()

  // (a) pre-enrich：检测 merge 是否改了 entry（对比原始 state vs 合并后 state）
  for (const modelId of merged.updatedModels) {
    const original = state[modelId]
    const postMerge = merged.state[modelId]
    if (original && postMerge && JSON.stringify(original) !== JSON.stringify(postMerge)) {
      realUpdatedSet.add(modelId)
    }
  }

  for (const modelId of allEnrichIds) {
    const entry = merged.state[modelId]
    if (entry) {
      // (b) enrich 前后对比：enrich 实际改了 metadata 才计入真实更新
      const beforeEnrich = trackSet.has(modelId) ? JSON.stringify(entry.metadata) : null
      try {
        entry.metadata = await enrichModel(modelId, entry.metadata)
      } catch {
        // enrichModel 内部已容错，这里兜底不中断流程
      }
      if (
        beforeEnrich !== null &&
        !realUpdatedSet.has(modelId) &&
        JSON.stringify(entry.metadata) !== beforeEnrich
      ) {
        realUpdatedSet.add(modelId)
      }
    }
    enriched++
    emit({ type: 'enrich', enriched, total })
  }

  // 动态路由补全 context_length / max_output_length：动态路由本身无上下文窗口
  // 信息（Cloudflare 路由 API 不返回），取 fallback 链中第一个有 context_length
  // 的模型的数据补全。链格式 'provider/model' 与 state key 一致，可直接查表。
  // 在 enrich 之后执行：链中真实模型已在本轮 enrich 填充 context_length。
  for (const [modelId, entry] of Object.entries(merged.state)) {
    if (!modelId.startsWith('dynamic/')) continue
    const chain = entry?.metadata?.route_models
    if (!Array.isArray(chain) || chain.length === 0) continue
    let source = null
    for (const ref of chain) {
      if (typeof ref !== 'string' || !ref.trim()) continue
      const refMeta = merged.state[ref]?.metadata
      if (refMeta?.context_length != null) {
        source = refMeta
        break
      }
    }
    if (!source) continue
    let changed = false
    if (entry.metadata.context_length !== source.context_length) {
      entry.metadata.context_length = source.context_length
      changed = true
    }
    if (source.max_output_length != null && entry.metadata.max_output_length !== source.max_output_length) {
      entry.metadata.max_output_length = source.max_output_length
      changed = true
    }
    if (changed) realUpdatedSet.add(modelId)
  }

  const summary = {
    newModels: merged.newModels,
    updatedModels: [...realUpdatedSet],
    removedModels: merged.removedModels,
    errors: discovery.errors,
  }
  let details
  try {
    details = buildSyncDetails(state, merged.state, summary)
  } catch {
    details = { added: [], removed: [], updated: [] }
  }
  return {
    state: merged.state,
    summary,
    details,
    providerSync,
  }
}
