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
import { mergeDiscovery as mergeDiscoveryImpl } from '../pipeline/merge.js'
import { enrichModel as enrichModelImpl } from '../pipeline/enrich.js'

/**
 * 同步流程编排（任务 27）：provider 同步 → discover → merge → enrich
 * 纯函数：不碰文件系统、不读 env、不弹 UI；一切依赖经 deps 注入。
 * @param {object} options
 * @param {object} options.config - loadConfig() 的结果（含 gateway + providers）
 * @param {string} options.gatewayToken - cfut_xxx
 * @param {string} [options.mgmtToken] - 管理 Token（可空，空则跳过 provider 同步）
 * @param {object} options.state - 当前 model-states 对象（会被合并出新对象，原对象不修改）
 * @param {object} [options.deps] - 依赖覆盖，字段：syncProvidersToConfig / discoverModels /
 *                                  mergeDiscovery / enrichModel（缺省绑定真实模块）
 * @param {(event: object) => void} [options.onEvent] - 进度事件回调（SSE 转发）
 *    事件对象：{ type: 'phase', phase: 'provider-sync'|'discover'|'enrich' }
 *            | { type: 'discover', ...onProgress 载荷 }
 *            | { type: 'enrich', enriched: number, total: number }
 *            | { type: 'provider-sync', ok: boolean, message?: string, skipped?: boolean,
 *                newProviders?: string[], removedProviders?: string[],
 *                errors?: Array<{source,message}> }（新增/移除明细供前端逐条日志）
 * @returns {Promise<{
 *   state: object,          // 合并+富化后的新 state（无结果时返回原 state）
 *   summary: { newModels: string[], updatedModels: string[], removedModels: string[],
 *              errors: Array<{provider,error}> }
 *   providerSync: { ok: boolean, skipped?: boolean, message?: string }
 * }>}
 */
export async function runSyncFlow({
  config,
  gatewayToken,
  mgmtToken,
  state,
  visibilityMap = null,
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
  } = deps

  const providerSync = { ok: true }

  // 1. provider 同步（管理 Token 缺失 / 失败均不中断，与 TUI 语义一致）
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

  // 2. 发现模型（onProgress 载荷原样透传）
  // 以 KV 可见性覆盖 config.providers 的 enabled，使隐藏的 provider 不参与发现
  emit({ type: 'phase', phase: 'discover' })
  const discoverConfig = {
    ...config,
    providers: applyVisibility(Array.isArray(config.providers) ? config.providers : [], visibilityMap),
  }
  const discovery = await discoverModels(discoverConfig, gatewayToken, (p) => {
    emit({ type: 'discover', ...p })
  })

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
      providerSync,
    }
  }

  // 3. 合并（策略 A：provider 覆盖，消失模型标记 removed）+ 富化新模型
  emit({ type: 'phase', phase: 'enrich' })
  const merged = mergeDiscovery(state, discovery)
  const total = merged.newModels.length
  let enriched = 0
  for (const modelId of merged.newModels) {
    const entry = merged.state[modelId]
    if (entry) {
      try {
        entry.metadata = await enrichModel(modelId, entry.metadata)
      } catch {
        // enrichModel 内部已容错，这里兜底不中断流程
      }
    }
    enriched++
    emit({ type: 'enrich', enriched, total })
  }

  return {
    state: merged.state,
    summary: {
      newModels: merged.newModels,
      updatedModels: merged.updatedModels,
      removedModels: merged.removedModels,
      errors: discovery.errors,
    },
    providerSync,
  }
}
