/**
 * 任务 25/26/27：Web 服务器基础 + 模型管理 API + 同步/保存部署 API
 *
 * 本地 HTTP 管理服务器骨架：Hono 应用 + 静态文件服务（src/web/public/）。
 * 任务 26 起扩展模型管理 API（8 个端点，见下方「任务 26」段）；
 * 任务 27 起新增同步 + 保存部署 API（4 个端点 + SSE 进度流，见「任务 27」段）。
 * 仅监听 127.0.0.1；随机端口（port: 0）；启动后可选自动打开浏览器；
 * SIGINT/SIGTERM 优雅关闭；浏览器页面全部关闭后心跳超时自动退出（桌面应用式
 * 关闭语义：网页是 UI 唯一入口，关页面即关服务器）。被 import 时不自动启动（isMain 保护）。
 *
 * 已知约束（勿违反）：
 * - @hono/node-server 锁 ^1.19.17（2.x 要求 Node>=20，破坏 engines >=18 承诺）
 * - 静态服务用 '@hono/node-server/serve-static'（'hono/serve-static' 是 Deno/Bun 适配）
 * - serveStatic 的 root 相对 process.cwd()，必须用 import.meta.url 解析绝对路径
 * - URL 一律 127.0.0.1，不用 localhost（部分系统解析到 ::1 连不上）
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import { loadState, saveState, upsertModel } from '../core/state.js'
import { loadConfig, setDebugFlag } from '../core/config.js'
import { readToken, readManagementToken } from '../core/token-store.js'
import { writeModelsJson } from '../output/generate.js'
import { deployProviderRoutesToKV } from '../output/deploy.js'
import {
  toggleStatus,
  markRemovedOrDelete,
  toggleAllStatus,
  collectProviders,
  applyModelFilters,
  editModelMetadata,
  syncProvidersToConfig,
  saveAndDeploy,
  hiddenProviderSlugs,
  filterVisibleState,
} from '../tui/actions.js'
import { discoverModels, gatewaySlug } from '../cloudflare/discover.js'
import { fetchCloudProviders } from '../cloudflare/providers-sync.js'
import { readKvJson, writeKvJson } from '../cloudflare/kv.js'
import { mergeDiscovery } from '../pipeline/merge.js'
import { enrichModel } from '../pipeline/enrich.js'
import {
  mergeProviderViews,
  buildCloudUpdateParams,
  updateProviderCloud,
  createProviderCloud,
  buildCloudDeleteParams,
  deleteProviderCloud,
  followDelete,
  setLocalEnabled,
  setLocalName,
  setLocalBaseUrl,
  writeProvidersConfigFile,
  applyVisibility,
  buildVisibilityMap,
} from '../tui/provider-actions.js'
import { runSyncFlow } from './sync-flow.js'
import {
  SLOTS,
  summarizeTokenStatus,
  summarizeGatewayInfo,
  updateToken,
  clearSlotToken,
  buildWorkersStatus,
  checkKVKey,
} from '../tui/account-actions.js'

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url))
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 应用版本：读项目根 package.json（src/web/ 上溯两级）；读取失败降级 unknown
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')
    )
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
})()

// 心跳自动退出（桌面应用式关闭语义）：页面存活期间前端定期上报心跳，全部页面
// 关闭后服务器自动退出。GOODBYE_GRACE 覆盖刷新场景：pagehide/sendBeacon 发送
// goodbye 加速退出，新页面首个心跳在宽限内到达即取消退出。
// 超时设为 3 分钟：浏览器对后台标签页的 setInterval 会节流到 ~1 次/分钟，
// 15s 会误判。3 分钟窗口足够容忍节流，同时仍能在页面全部关闭后清理孤进程。
const DEFAULT_HEARTBEAT_TIMEOUT = 180000 // 3min 无心跳 → 自动退出
const HEARTBEAT_CHECK_INTERVAL = 1000   // 心跳超时检查周期（ms）
const GOODBYE_GRACE = 5000              // goodbye 后宽限（ms），期间新心跳取消退出

// 跨 PC 同步 provider 可见性（id → enabled）的 KV 键名
const PROVIDER_VISIBILITY_KV_KEY = 'provider-visibility'

// 缺省 stateStore：绑定真实 data/model-states.json（测试注入内存 mock 隔离）
const DEFAULT_STATE_STORE = { load: loadState, save: saveState }

// 缺省 configStore / deps：绑定真实模块（测试注入 mock 隔离）
const DEFAULT_CONFIG_STORE = { load: loadConfig }
const DEFAULT_DEPS = {
  syncProvidersToConfig,
  discoverModels,
  mergeDiscovery,
  enrichModel,
  saveAndDeploy,
  writeModelsJson,
  readToken,
  readManagementToken,
  // 任务 28：Provider 管理 API
  fetchCloudProviders,
  mergeProviderViews,
  updateProviderCloud,
  createProviderCloud,
  applyVisibility,
  deleteProviderCloud,
  writeProvidersConfigFile,
  deployProviderRoutesToKV,
  readKvVisibility: async (apiToken, accountId, namespaceId) =>
    readKvJson(apiToken, accountId, namespaceId, PROVIDER_VISIBILITY_KV_KEY, {}),
  writeKvVisibility: async (apiToken, accountId, namespaceId, map) =>
    writeKvJson(apiToken, accountId, namespaceId, PROVIDER_VISIBILITY_KV_KEY, map),
  // 任务 29：Worker + 账户管理 API
  summarizeTokenStatus,
  summarizeGatewayInfo,
  updateToken,
  clearSlotToken,
  buildWorkersStatus,
  checkKVKey,
  loadModelsJsonState,
  setDebugFlag,
  spawnFn: spawn,
}

// 任务 29：清除 Token 影响面文案（交付包 §4.4 两套固定文案，槽位不同）
const IMPACT_TEXT = {
  management: '管理 API Token 已清除：将无法进行云端 Provider 同步/编辑/删除、模型同步、Worker 部署等账户级操作（不影响已保存的本地数据）',
  gateway: 'Gateway Token（cfut_xxx）已清除：模型发现（同步）将不可用；需在 Cloudflare dashboard 的网关 Settings 重新创建后粘贴',
}

// 任务 29：部署 / 向导子进程路径（src/web/ 上溯：scripts 到项目根，bin 在 src/ 下）
const SCRIPTS_DEPLOY_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'deploy.mjs')
const AIGD_BIN_PATH = path.resolve(__dirname, '..', 'bin', 'aigd.js')

// 任务 28：按 type 统计 provider 数（Custom Providers / BYOK），供
// /api/providers 响应 sourceCounts 字段（前端详细日志展示「Custom X / BYOK Y」）
function countByType(providers) {
  let custom = 0
  let byok = 0
  for (const p of providers || []) {
    if (!p || typeof p.type !== 'string') continue
    if (p.type === 'byok') byok++
    else if (p.type === 'custom-provider') custom++
  }
  return { custom, byok }
}

/**
 * 任务 29 缺省 loadModelsJsonState：读 data/models.json → { exists, count }
 * （测试注入 mock 免读真实文件；缺失 / 解析失败按不存在处理，不抛错）
 */
function loadModelsJsonState() {
  try {
    const models = JSON.parse(
      readFileSync(path.resolve(__dirname, '..', '..', 'data', 'models.json'), 'utf8')
    )
    const count = Array.isArray(models) ? models.length : null
    return { exists: count !== null, count }
  } catch {
    return { exists: false, count: null }
  }
}

/**
 * 解析 JSON 请求体；body 缺失 / 非法 JSON → 返回 null（调用方统一回 400）。
 * @param {import('hono').Context} c
 * @returns {Promise<object|null>}
 */
async function readJsonBody(c) {
  try {
    return await c.req.json()
  } catch {
    return null
  }
}

/**
 * 创建 Hono 应用（不含网络监听）。测试可直接用 app.request() 模拟 HTTP。
 * @param {object} [options]
 * @param {string} [options.publicDir] 静态文件根目录（绝对路径）。默认 src/web/public
 * @param {{ load: () => object, save: (state) => void }} [options.stateStore]
 *        模型状态存储（任务 26 新增）。缺省绑定 loadState/saveState（data/model-states.json）。
 *        服务器创建时调用 load() 一次，每次变更端点后调用 save(state)。
 * @param {{ load: () => object }} [options.configStore]
 *        配置存储（任务 27 新增）。缺省 loadConfig（读 data/providers.json）。
 * @param {object} [options.deps]
 *        业务依赖覆盖（任务 27/28/29 新增），字段见 DEFAULT_DEPS（缺省绑定真实模块）：
 *        syncProvidersToConfig / discoverModels / mergeDiscovery / enrichModel /
 *        saveAndDeploy / writeModelsJson / readToken / readManagementToken /
 *        fetchCloudProviders / mergeProviderViews / updateProviderCloud /
 *        createProviderCloud / deleteProviderCloud / writeProvidersConfigFile /
 *        summarizeTokenStatus /
 *        summarizeGatewayInfo / updateToken / clearSlotToken / buildWorkersStatus /
 *        checkKVKey / loadModelsJsonState / spawnFn（部署/向导子进程；
 *        部署超时可用 deps.deployTimeoutMs 覆盖，默认 120s）
 * @param {{ lastHeartbeat: number|null, goodbyeAt: number|null }} [options.heartbeatState]
 *        心跳状态（startServer 创建并注入，配合前端心跳实现「页面全部关闭 →
 *        自动退出」）。缺省 null：/api/heartbeat 仅返回 ok、不记录（直接 createApp 场景）
 * @returns {Hono}
 */
export function createApp({
  publicDir = DEFAULT_PUBLIC_DIR,
  stateStore = DEFAULT_STATE_STORE,
  configStore = DEFAULT_CONFIG_STORE,
  deps = {},
  heartbeatState = null,
} = {}) {
  const app = new Hono()
  // 内存态：createApp 闭包变量，非模块级单例（测试可多次 createApp 隔离状态）
  // 任务 27 起同步完成后整体替换（let），任务 26 端点原地修改
  let state = stateStore.load()
  const depsAll = { ...DEFAULT_DEPS, ...deps }

  // 任务 27：同步状态 + SSE 进度总线（同一时刻至多 1 个订阅者）
  let syncing = false
  let sseSubscriber = null
  let sseResolve = null
  const emitEvent = (ev) => {
    if (sseSubscriber) sseSubscriber(ev)
  }

  // 未捕获异常统一 500 + { error }
  app.onError((err, c) => {
    console.error('[aigd] API 错误:', err)
    return c.json({ error: err.message || 'internal server error' }, 500)
  })

  // 健康检查：前端确认后端存活（附带应用版本供页头展示）
  app.get('/api/health', (c) => c.json({ ok: true, version: APP_VERSION }))

  // 心跳：前端页面存活期间定期 POST；?goodbye=1（pagehide/sendBeacon）标记页面
  // 正在关闭，加速服务器退出。startServer 据此实现「全部页面关闭 → 自动退出」。
  app.post('/api/heartbeat', (c) => {
    if (heartbeatState) {
      heartbeatState.lastHeartbeat = Date.now()
      heartbeatState.goodbyeAt = null // 新心跳取消 goodbye（刷新场景新页面首心跳）
      if (c.req.query('goodbye') === '1') heartbeatState.goodbyeAt = Date.now()
    }
    return c.json({ ok: true })
  })

  // ─── 任务 26：模型管理 API（注册在静态文件中间件之前）───

  // GET /api/state — 完整 model-states（隐藏 provider 下的模型不返回，仅 UI 过滤）
  app.get('/api/state', (c) => {
    const config = configStore.load()
    const hidden = hiddenProviderSlugs(Array.isArray(config.providers) ? config.providers : [])
    return c.json({ ok: true, state: filterVisibleState(state, hidden) })
  })

  // POST /api/models/toggle — 切换 selected ↔ hidden
  app.post('/api/models/toggle', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.modelId !== 'string' || !body.modelId) {
      return c.json({ error: 'modelId is required' }, 400)
    }
    if (!state[body.modelId]) return c.json({ error: 'model not found' }, 404)
    const changed = toggleStatus(state, body.modelId)
    if (changed) stateStore.save(state)
    return c.json({ ok: true, changed, entry: state[body.modelId] })
  })

  // POST /api/models/remove — 一次性永久删除（entry → null）
  app.post('/api/models/remove', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.modelId !== 'string' || !body.modelId) {
      return c.json({ error: 'modelId is required' }, 400)
    }
    if (!state[body.modelId]) return c.json({ error: 'model not found' }, 404)
    const changed = markRemovedOrDelete(state, body.modelId)
    if (changed) stateStore.save(state)
    return c.json({ ok: true, changed, entry: state[body.modelId] ?? null })
  })

  // POST /api/models/batch-toggle — 批量切换（modelIds 缺省 = 全部非 removed）
  app.post('/api/models/batch-toggle', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (body.modelIds !== undefined && !Array.isArray(body.modelIds)) {
      return c.json({ error: 'modelIds must be an array' }, 400)
    }
    // 预计算目标状态与参与数量（与 toggleAllStatus 内部逻辑一致：removed 永不参与）
    const ids = Array.isArray(body.modelIds) ? body.modelIds : Object.keys(state)
    const targets = ids.filter((id) => state[id] && state[id].status !== 'removed')
    const currentSelected = targets.filter((id) => state[id].status === 'selected').length
    const targetStatus = currentSelected > 0 ? 'hidden' : 'selected'
    const changed = toggleAllStatus(state, body.modelIds)
    if (changed) stateStore.save(state)
    return c.json({ ok: true, changed, status: targetStatus, count: targets.length })
  })

  // POST /api/models/batch-remove — 批量永久删除（modelIds 缺省 = 全部非 removed）
  app.post('/api/models/batch-remove', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (body.modelIds !== undefined && !Array.isArray(body.modelIds)) {
      return c.json({ error: 'modelIds must be an array' }, 400)
    }
    const ids = Array.isArray(body.modelIds) ? body.modelIds : Object.keys(state)
    const targets = ids.filter((id) => state[id])
    if (targets.length === 0) {
      return c.json({ ok: true, changed: false, count: 0 })
    }
    for (const id of targets) {
      markRemovedOrDelete(state, id)
    }
    stateStore.save(state)
    return c.json({ ok: true, changed: true, count: targets.length })
  })

  // POST /api/models/edit — 编辑元数据（留空不覆盖，context_length/max_output_length 转数字）
  app.post('/api/models/edit', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.modelId !== 'string' || !body.modelId) {
      return c.json({ error: 'modelId is required' }, 400)
    }
    if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
      return c.json({ error: 'fields is required' }, 400)
    }
    if (!state[body.modelId]) return c.json({ error: 'model not found' }, 404)
    const changed = editModelMetadata(state, body.modelId, body.fields)
    if (changed) stateStore.save(state)
    return c.json({ ok: true, metadata: state[body.modelId].metadata || {} })
  })

  // POST /api/models/add — 手动添加模型（status 恒 selected）
  app.post('/api/models/add', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.modelId !== 'string' || !body.modelId) {
      return c.json({ error: 'modelId is required' }, 400)
    }
    if (typeof body.provider !== 'string' || !body.provider) {
      return c.json({ error: 'provider is required' }, 400)
    }
    if (
      body.metadata !== undefined &&
      (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return c.json({ error: 'metadata must be an object' }, 400)
    }
    upsertModel(state, body.modelId, body.provider, body.metadata || {})
    stateStore.save(state)
    return c.json({ ok: true, entry: state[body.modelId] })
  })

  // GET /api/models/filtered — 组合筛选（provider + keyword + status，均可选）
  app.get('/api/models/filtered', (c) => {
    const provider = c.req.query('provider') || null
    const keyword = c.req.query('keyword') || null
    const status = c.req.query('status') || null
    const config = configStore.load()
    const hidden = hiddenProviderSlugs(Array.isArray(config.providers) ? config.providers : [])
    const visibleState = filterVisibleState(state, hidden)
    const items = applyModelFilters(visibleState, { provider, keyword, status })
    return c.json({ ok: true, count: items.length, items })
  })
  // GET /api/providers/list — 返回 config 中所有启用 provider + state 中出现的 provider
  // （config 有但 state 无 → 新 provider 尚未同步；state 有但 config 无 → 已删除的 provider）
  app.get('/api/providers/list', (c) => {
    const config = configStore.load()
    const localProviders = Array.isArray(config.providers) ? config.providers : []
    // 构建名称映射：同时匹配原始 id 和 gateway slug（custom-provider 带 custom- 前缀）
    const nameMap = new Map()
    for (const p of localProviders) {
      nameMap.set(p.id, p.name || p.id)
      if (p.type === 'custom-provider' && !p.id.startsWith('custom-')) {
        nameMap.set(`custom-${p.id}`, p.name || p.id)
      }
    }
    // 取 config 中启用的 provider + state 中出现的 provider（并集）；
    // state 中属于隐藏 provider 的条目剔除（不展示在侧栏）
    const hidden = hiddenProviderSlugs(localProviders)
    const slugs = collectProviders(state).filter((s) => !hidden.has(s))
    const enabledSlugs = new Set(
      localProviders
        .filter((p) => p.enabled)
        .map((p) => (p.type === 'custom-provider' && !String(p.id).startsWith('custom-') ? `custom-${p.id}` : p.id))
    )
    const allSlugs = [...new Set([...slugs, ...enabledSlugs])].sort()
    const providers = allSlugs.map((id) => {
      let name = nameMap.get(id) || id
      // Cloudflare 将「未设置别名」的 BYOK provider 返回 alias: "default"，
      // 防御性兜底：name 为 "default" 或等于 id 时使用 slug 作为显示名
      if (name === 'default' || name === id) name = id
      return { id, name }
    })
    return c.json({ ok: true, providers })
  })

  // ─── 任务 27：同步 + 保存部署 API（注册在静态文件中间件之前）───

  // GET /api/sync/progress — SSE 进度流
  // 订阅「当前同步」的事件（前端先连 SSE 再发 POST /api/sync，避免丢事件）。
  // 同步结束后收到 done/error 事件并关闭流；无同步进行时连接保持打开。
  app.get('/api/sync/progress', (c) => {
    return streamSSE(c, async (stream) => {
      sseSubscriber = (ev) => {
        const { type, ...data } = ev
        const terminal = type === 'done' || type === 'error'
        const finish = () => {
          if (sseResolve) {
            const r = sseResolve
            sseResolve = null
            r()
          }
        }
        try {
          const write = stream.writeSSE({ event: type, data: JSON.stringify(data) })
          // 终态事件必须写完再关闭流；普通事件 fire-and-forget
          if (terminal) write.catch(() => {}).finally(finish)
          else write.catch(() => {})
        } catch {
          if (terminal) finish()
        }
      }
      // 等待 done/error（或客户端断开）；流关闭后清理订阅
      await new Promise((resolve) => {
        sseResolve = resolve
      })
      if (sseSubscriber) sseSubscriber = null
      sseResolve = null
    })
  })

  // GET /api/sync/ready — 方案 1 自动同步前置探测（轻量，不触网）
  // 返回 { ready } 供前端判断是否具备同步条件；ready = Gateway Token 已配置
  app.get('/api/sync/ready', (c) => {
    const gatewayToken = process.env.GATEWAY_TOKEN || depsAll.readToken()
    return c.json({ ok: true, ready: Boolean(gatewayToken) })
  })

  // ─── 调试日志开关（providers.json 顶层 debug 字段，写盘持久化）───

  // GET /api/settings/debug — 读取详细日志开关当前状态
  app.get('/api/settings/debug', (c) => {
    const config = configStore.load()
    return c.json({ ok: true, enabled: config.debug === true })
  })

  // POST /api/settings/debug — 切换详细日志（开启后 discover 输出每个 provider
  // /models 调用的完整请求/响应：终端全文，Web 日志栏脱敏 + 截断预览）
  app.post('/api/settings/debug', async (c) => {
    const body = await readJsonBody(c)
    if (!body || typeof body.enabled !== 'boolean') {
      return c.json({ ok: false, error: 'enabled (boolean) 必填' }, 400)
    }
    try {
      depsAll.setDebugFlag(body.enabled)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, error: msg }, 500)
    }
    return c.json({ ok: true, enabled: body.enabled })
  })

  // POST /api/sync — 触发同步流程（provider 同步 → discover → merge → enrich）
  // 等同步完成后返回汇总；过程进度由 SSE 推送（并发 POST → 409）
  app.post('/api/sync', async (c) => {
    if (syncing) return c.json({ error: 'sync already in progress' }, 409)
    // Token 优先级：Gateway = env GATEWAY_TOKEN > 本地槽位；管理 = env CLOUDFLARE_API_TOKEN > 本地槽位
    const gatewayToken = process.env.GATEWAY_TOKEN || depsAll.readToken()
    if (!gatewayToken) {
      return c.json({ error: 'gateway token not configured' }, 400)
    }
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || depsAll.readManagementToken()
    syncing = true
    try {
      const config = configStore.load()
      // 读取 KV 可见性（跨 PC 真相）：失败静默降级（用本地 enabled）
      const gateway = config.gateway || {}
      const namespaceId = config.kv?.namespaceId || ''
      let visibilityMap = null
      if (mgmtToken && gateway.accountId && namespaceId) {
        try {
          visibilityMap = await depsAll.readKvVisibility(mgmtToken, gateway.accountId, namespaceId)
        } catch {
          visibilityMap = null
        }
      }
      const result = await runSyncFlow({
        config,
        gatewayToken,
        mgmtToken,
        state,
        visibilityMap,
        deps: { ...depsAll, applyVisibility: depsAll.applyVisibility },
        onEvent: emitEvent,
      })
      // 以 KV 为准回写本地 enabled（供 discover 离线降级一致），有变化才写
      if (visibilityMap && Array.isArray(config.providers)) {
        const next = depsAll.applyVisibility(config.providers, visibilityMap)
        if (next.some((p, i) => p.enabled !== config.providers[i].enabled)) {
          depsAll.writeProvidersConfigFile(next)
        }
      }
      // 同步完成后统一写盘一次（不逐模型写，与 TUI「合并后统一 dirty」一致）
      // 仅当有实际变更（新增/更新/移除）时才落盘，避免无变更同步触发“未保存”误判
      const hasChanges =
        (result.summary.newModels && result.summary.newModels.length > 0) ||
        (result.summary.updatedModels && result.summary.updatedModels.length > 0) ||
        (result.summary.removedModels && result.summary.removedModels.length > 0)
      state = result.state
      if (hasChanges) stateStore.save(state)
      emitEvent({ type: 'done', summary: result.summary })
      return c.json({ ok: true, summary: result.summary })
    } catch (err) {
      // SSE 推送 error 事件后关闭流（无订阅者时是 no-op），HTTP 层走 onError → 500
      emitEvent({ type: 'error', message: err.message || String(err) })
      throw err
    } finally {
      syncing = false
    }
  })

  // POST /api/save-deploy — 保存并提交三步（saveState → writeModelsJson → deployToKV）
  // 业务编排失败用 HTTP 200 + { ok:false, step, error }（非 HTTP 错误，前端按 body.ok 分支）
  app.post('/api/save-deploy', async (c) => {
    const config = configStore.load()
    const result = await depsAll.saveAndDeploy({ state, config })
    if (result.ok) return c.json({ ok: true })
    const error = result.error instanceof Error ? result.error.message : String(result.error)
    return c.json({ ok: false, step: result.step, error })
  })

  // POST /api/save — 仅保存（saveState + writeModelsJson 两步，不部署）
  app.post('/api/save', async (c) => {
    try {
      stateStore.save(state)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, step: 1, error: msg })
    }
    try {
      depsAll.writeModelsJson(state)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return c.json({ ok: false, step: 2, error: msg })
    }
    return c.json({ ok: true })
  })

  // ─── 任务 28：Provider 管理 API（注册在静态文件中间件之前）───

  // GET /api/providers 与 POST /api/providers/refresh 共用：
  // 拉取云端 + 合并本地展示；无管理 Token / 拉取失败 / gateway 未配置 → 只读降级。
  // 响应携带详情字段供前端底部日志栏逐条展示：
  //   sourceCounts: { custom, byok } — 按 type 统计的 provider 数
  //   cloudErrors: [{ source, message }] — 云端各源失败明细（source: 'custom-providers'
  //     | 'provider_configs' | 'cloud'（整体拉取抛错））；Error 实例 JSON 序列化会丢
  //     message，此处统一转为字符串
  //   degradedReason: 'no-token' | 'no-gateway' | 'fetch-failed' | '' — 只读降级原因
  const handleProvidersList = async (c) => {
    const config = configStore.load()
    const localProviders = Array.isArray(config.providers) ? config.providers : []
    const gateway = config.gateway || {}
    const namespaceId = config.kv?.namespaceId || ''
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || depsAll.readManagementToken()
    const kvReady = Boolean(mgmtToken && gateway.accountId && namespaceId)

    // KV 是跨 PC 可见性真相源：加载时读取并覆盖本地 enabled（失败静默降级到本地）
    let visibilityMap = {}
    let visibilityError = null
    if (kvReady) {
      try {
        visibilityMap = await depsAll.readKvVisibility(mgmtToken, gateway.accountId, namespaceId)
      } catch (error) {
        visibilityError = error instanceof Error ? error.message : String(error ?? '未知错误')
      }
    }

    if (!mgmtToken || !gateway.accountId || !gateway.gatewayId) {
      // 只读降级：本地缓存原样展示（mark 全 null）；KV 不可用，本地 enabled 原样
      const merged = depsAll.mergeProviderViews(localProviders, null)
      return c.json({
        ok: true,
        providers: merged.providers,
        readonly: true,
        sourceCounts: countByType(localProviders),
        cloudErrors: [],
        degradedReason: !mgmtToken ? 'no-token' : 'no-gateway',
      })
    }

    let cloudResult = null
    let fetchError = null
    try {
      cloudResult = await depsAll.fetchCloudProviders(mgmtToken, gateway.accountId, gateway.gatewayId)
    } catch (error) {
      // 拉取失败 → 只读降级（mergeProviderViews 的 null 入参语义）；错误原文留给前端日志
      fetchError = error instanceof Error ? error.message : String(error ?? '未知错误')
    }
    const merged = depsAll.mergeProviderViews(localProviders, cloudResult)
    // 以 KV 为准覆盖可见性（影响展示 + 回写本地供 discover 跳过）
    merged.providers = depsAll.applyVisibility(merged.providers, visibilityMap)

    // KV 与本地 enabled 不一致（其他 PC 改过）→ 回写本地缓存，使 discover 行为一致。
    // 仅更新已有本地条目；云端新增条目（mark=new）不在此持久化（沿用既有流程）。
    const mergedById = new Map(merged.providers.map((p) => [p.id, p]))
    let localChanged = false
    const nextLocal = localProviders.map((p) => {
      const m = mergedById.get(p.id)
      if (m && typeof m.enabled === 'boolean' && m.enabled !== p.enabled) {
        localChanged = true
        return { ...p, enabled: m.enabled }
      }
      return p
    })
    if (localChanged) depsAll.writeProvidersConfigFile(nextLocal)

    const cloudErrors = []
    for (const e of cloudResult?.errors ?? []) {
      cloudErrors.push({
        source: e.source,
        message: e.error instanceof Error ? e.error.message : String(e.error ?? '未知错误'),
      })
    }
    if (fetchError) cloudErrors.push({ source: 'cloud', message: fetchError })
    if (visibilityError) cloudErrors.push({ source: 'kv-visibility', message: visibilityError })
    return c.json({
      ok: true,
      providers: merged.providers,
      readonly: merged.readonly,
      sourceCounts: countByType(cloudResult ? cloudResult.providers : localProviders),
      cloudErrors,
      degradedReason: fetchError ? 'fetch-failed' : '',
    })
  }

  app.get('/api/providers', handleProvidersList)
  app.post('/api/providers/refresh', handleProvidersList)

  // POST /api/providers/update — 编辑 provider：
  //   name/apiKey 走云端变更（需管理 Token）；
  //   localEnabled（可见性/隐藏）写本地 providers.json 并同步 KV provider-visibility
  //   （跨 PC 一致，需管理 Token）；pathPrefix 仅本地 + 同步 KV provider-routes。
  // unsupported 一律 400 透传文案。
  app.post('/api/providers/update', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.id !== 'string' || !body.id) {
      return c.json({ error: 'id is required' }, 400)
    }
    const changes = body.changes
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return c.json({ error: 'changes is required' }, 400)
    }
    // 字段类型校验：空串 / null / undefined 视为不修改
    if (changes.name !== undefined && changes.name !== null && (typeof changes.name !== 'string' || !changes.name)) {
      return c.json({ error: 'changes.name must be a non-empty string' }, 400)
    }
    if (changes.apiKey !== undefined && changes.apiKey !== null && typeof changes.apiKey !== 'string') {
      return c.json({ error: 'changes.apiKey must be a string' }, 400)
    }
    if (changes.localEnabled !== undefined && changes.localEnabled !== null && typeof changes.localEnabled !== 'boolean') {
      return c.json({ error: 'changes.localEnabled must be a boolean' }, 400)
    }
    // pathPrefix 可选：存在时必须是 string
    if (changes.pathPrefix !== undefined && changes.pathPrefix !== null && typeof changes.pathPrefix !== 'string') {
      return c.json({ error: 'changes.pathPrefix must be a string' }, 400)
    }
    // baseUrl 可选：存在时必须是非空 http(s) 字符串（仅 custom-provider 有意义；
    // BYOK 由 buildCloudUpdateParams 拦截）
    if (changes.baseUrl !== undefined && changes.baseUrl !== null &&
        (typeof changes.baseUrl !== 'string' || !/^https?:\/\//.test(changes.baseUrl))) {
      return c.json({ error: 'changes.baseUrl must be an http(s) string' }, 400)
    }

    const config = configStore.load()
    let local = Array.isArray(config.providers) ? config.providers : []
    let provider = local.find((p) => p.id === body.id)
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || depsAll.readManagementToken()
    const gateway = config.gateway || {}

    // 本地找不到？尝试从云端拉取（provider 可能是通过 dashboard 创建后首次在 Web UI 编辑）
    if (!provider) {
      if (mgmtToken && gateway.accountId && gateway.gatewayId) {
        try {
          const cloudResult = await depsAll.fetchCloudProviders(mgmtToken, gateway.accountId, gateway.gatewayId)
          const cloudProvider = cloudResult?.providers?.find((p) => p.id === body.id)
          if (cloudProvider) {
            // 追加到本地配置，后续 writeProvidersConfigFile 会持久化
            local = [...local, cloudProvider]
            provider = cloudProvider
          }
        } catch {
          // 拉取失败，继续返回 404
        }
      }
    }

    if (!provider) return c.json({ error: 'provider not found' }, 404)

    const namespaceId = config.kv?.namespaceId || ''

    const name = changes.name ?? null
    const apiKey = changes.apiKey ?? null
    const baseUrl = changes.baseUrl ?? null
    const visibilityChanged = typeof changes.localEnabled === 'boolean'
    const hasCloudChange = Boolean(name) || Boolean(apiKey) || Boolean(baseUrl)

    // 云端变更（name/apiKey）与可见性变更都需要管理 Token
    if ((hasCloudChange || visibilityChanged) && !mgmtToken) {
      return c.json({ error: 'management token not configured' }, 400)
    }
    if (hasCloudChange && (!gateway.accountId || !gateway.gatewayId)) {
      return c.json({ error: 'gateway config not initialized' }, 400)
    }

    // 云端更新端点（PATCH /custom-providers/{id}、PUT /provider_configs/{id}）
    // 要求 UUID（cloudId）而非 slug（实测 7001 "Invalid uuid"）：
    // 本地旧数据缺 cloudId 时拉云端补全（后续写盘持久化）；拉取失败则交由
    // buildCloudUpdateParams 提示刷新。
    if (hasCloudChange && !provider.cloudId) {
      try {
        const cloudResult = await depsAll.fetchCloudProviders(mgmtToken, gateway.accountId, gateway.gatewayId)
        const cloudProvider = cloudResult?.providers?.find((p) => p.id === body.id)
        if (cloudProvider) {
          local = local.map((p) => (p.id === body.id ? { ...p, cloudId: cloudProvider.cloudId, type: cloudProvider.type } : p))
          provider = { ...provider, cloudId: cloudProvider.cloudId, type: cloudProvider.type }
        }
      } catch {
        // 拉取失败：沿用现有 provider（buildCloudUpdateParams 会提示刷新）
      }
    }

    let cloudChanged = false
    if (hasCloudChange) {
      // unsupported（BYOK 改名无 Key / Custom 传 Key 等）先行判定，400 透传文案
      const built = buildCloudUpdateParams(provider, { name, apiKey, baseUrl })
      if (!built.ok) return c.json({ error: built.unsupported }, 400)
      const r = await depsAll.updateProviderCloud(
        mgmtToken, gateway.accountId, gateway.gatewayId, provider, { name, apiKey, baseUrl }
      )
      if (r.unsupported) return c.json({ error: r.unsupported }, 400)
      if (!r.ok) {
        const msg = r.error instanceof Error ? r.error.message : 'cloud update failed'
        return c.json({ error: msg }, 400)
      }
      // 云端成功：name 有变更 → 同步本地 name（保持展示一致）
      if (name) local = setLocalName(local, body.id, name)
      // baseUrl 有变更 → 同步本地 base_url（编辑表单预填一致）
      if (baseUrl) local = setLocalBaseUrl(local, body.id, baseUrl)
      cloudChanged = true
    }

    let localChanged = cloudChanged
    let routesChanged = false // pathPrefix 变化才需要推 KV provider-routes
    if (visibilityChanged) {
      local = setLocalEnabled(local, body.id, changes.localEnabled)
      localChanged = true
    }
    // pathPrefix 是本地字段（仅用于 worker 路由）
    if (changes.pathPrefix !== undefined) {
      const idx = local.findIndex((p) => p.id === body.id)
      if (idx !== -1) {
        const prev = local[idx].pathPrefix || ''
        const next = changes.pathPrefix || ''
        if (changes.pathPrefix === '') {
          // 空串 = 清除 pathPrefix
          const { pathPrefix: _, ...rest } = local[idx]
          local[idx] = rest
        } else {
          local[idx] = { ...local[idx], pathPrefix: changes.pathPrefix }
        }
        localChanged = true
        if (prev !== next) routesChanged = true
      }
    }

    if (localChanged) {
      depsAll.writeProvidersConfigFile(local)
    }

    // KV 同步：
    //   - 可见性变化 → 写 provider-visibility（跨 PC 一致）
    //   - pathPrefix 变化 → 写 provider-routes（worker 路由即时生效）
    // 未配置 namespaceId → skipped；推送失败不回滚（云端/本地已成功），
    // 由前端提示并可在模型页【部署更改】重试。
    let kvDeployed = true
    let kvSkipped = false
    let kvError = null
    const tryKv = async (fn) => {
      try {
        const r = await fn()
        if (r && r.skipped) { kvDeployed = false; kvSkipped = true }
        else if (r && r.success === false) { kvDeployed = false; kvError = r.output || 'KV 部署失败' }
      } catch (err) {
        kvDeployed = false
        kvError = err instanceof Error ? err.message : String(err)
      }
    }
    if (visibilityChanged) {
      if (!namespaceId) {
        kvDeployed = false; kvSkipped = true
      } else {
        await tryKv(() => depsAll.writeKvVisibility(
          mgmtToken, gateway.accountId, namespaceId, buildVisibilityMap(local)
        ))
      }
    }
    if (routesChanged) {
      await tryKv(() => depsAll.deployProviderRoutesToKV({ ...config, providers: local }))
    }

    // 重新合并展示（无云端上下文 → mark null），返回该条目的最新形态
    const display = depsAll.mergeProviderViews(local, null)
    const providerView = display.providers.find((p) => p.id === body.id)
    return c.json({
      ok: true,
      provider: providerView,
      cloudChanged,
      localChanged,
      kvDeployed,
      kvSkipped,
      kvError,
    })
  })

  // POST /api/providers/create — 添加 provider（FP2）：云端创建 + 本地落盘。
  // 校验（全部 400）：非 JSON / 非法 type / 缺 id 或非法 slug / name、apiKey、
  // pathPrefix 非 string / byok 缺 apiKey / custom 缺或非 http(s) baseUrl；
  // 随后要求管理 Token 与 gateway 配置；本地或云端已存在同 id → 400；
  // 云端创建失败 → 400 透传 reason / error.message。
  app.post('/api/providers/create', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (body.type !== 'byok' && body.type !== 'custom-provider') {
      return c.json({ error: 'type must be byok or custom-provider' }, 400)
    }
    if (typeof body.id !== 'string' || !body.id) {
      return c.json({ error: 'id is required' }, 400)
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.id)) {
      return c.json({ error: 'id must be a lowercase slug (letters, digits, hyphens)' }, 400)
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      return c.json({ error: 'name must be a string' }, 400)
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
      return c.json({ error: 'apiKey must be a string' }, 400)
    }
    if (body.pathPrefix !== undefined && typeof body.pathPrefix !== 'string') {
      return c.json({ error: 'pathPrefix must be a string' }, 400)
    }
    if (body.type === 'byok' && (typeof body.apiKey !== 'string' || !body.apiKey.trim())) {
      return c.json({ error: 'byok requires apiKey' }, 400)
    }
    if (body.type === 'custom-provider' && (typeof body.baseUrl !== 'string' || !/^https?:\/\//.test(body.baseUrl))) {
      return c.json({ error: 'custom-provider requires baseUrl (http:// or https://)' }, 400)
    }

    const config = configStore.load()
    const gateway = config.gateway || {}
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || depsAll.readManagementToken()
    if (!mgmtToken) {
      return c.json({ error: 'management token not configured' }, 400)
    }
    // custom-provider 云端创建不需要 gatewayId（createCustomFn 无此参数），仅 byok 要求
    if (!gateway.accountId || (body.type === 'byok' && !gateway.gatewayId)) {
      return c.json({ error: 'gateway config not initialized' }, 400)
    }

    let local = Array.isArray(config.providers) ? config.providers : []

    // 查重：本地已有同 id，或云端已有同 id（拉取失败忽略不阻断）→ 400
    if (local.some((p) => p && p.id === body.id)) {
      return c.json({ error: `provider '${body.id}' 已存在` }, 400)
    }
    try {
      const cloudResult = await depsAll.fetchCloudProviders(mgmtToken, gateway.accountId, gateway.gatewayId)
      const cloudDup = (cloudResult?.providers || []).find((p) => p && p.id === body.id)
      if (cloudDup) {
        return c.json({ error: `provider '${body.id}' 已存在` }, 400)
      }
    } catch {
      // 拉取失败忽略，不阻断创建流程（云端查重尽力而为）
    }

    const r = await depsAll.createProviderCloud(mgmtToken, gateway.accountId, gateway.gatewayId, body)
    if (!r.ok) {
      const msg = r.reason || (r.error instanceof Error ? r.error.message : 'cloud create failed')
      return c.json({ error: msg }, 400)
    }

    // 落盘：entry 附 pathPrefix（仅 custom 且非空），写回本地 providers 数组
    const entry = r.entry
    if (body.pathPrefix && body.type === 'custom-provider') {
      entry.pathPrefix = body.pathPrefix
    }
    local = [...local, entry]
    depsAll.writeProvidersConfigFile(local)

    // KV 同步：带 pathPrefix → 重推 provider-routes（worker 路由即时生效）。
    // 无 pathPrefix 不动 KV（kvDeployed 保持 true）；推送失败不回滚
    // （云端 + 本地已成功），由前端提示并可在模型页【部署更改】重试。
    let kvDeployed = true
    let kvSkipped = false
    let kvError = null
    const tryKv = async (fn) => {
      try {
        const r = await fn()
        if (r && r.skipped) { kvDeployed = false; kvSkipped = true }
        else if (r && r.success === false) { kvDeployed = false; kvError = r.output || 'KV 部署失败' }
      } catch (err) {
        kvDeployed = false
        kvError = err instanceof Error ? err.message : String(err)
      }
    }
    if (entry.pathPrefix) {
      await tryKv(() => depsAll.deployProviderRoutesToKV({ ...config, providers: local }))
    }

    // 重新合并展示（无云端上下文 → mark null），返回新条目
    const display = depsAll.mergeProviderViews(local, null)
    const providerView = display.providers.find((p) => p.id === body.id)
    return c.json({
      ok: true,
      provider: providerView,
      cloudChanged: true,
      localChanged: true,
      kvDeployed,
      kvSkipped,
      kvError,
    })
  })

  // ─── 删除确认辅助函数 ──────────────────────────────────

  /**
   * 删除云端 provider 并验证是否真正删除。
   *
   * Cloudflare DELETE /provider_configs/{uuid} 有时返回 200/success:true
   * 但实际并未删除记录。本函数在删除后调用 fetchCloudProviders 确认，
   * 如果仍在则自动重试（最多 maxRetries 次）。
   *
   * @param {Function} deleteFn - depsAll.deleteProviderCloud
   * @param {Function} fetchFn - depsAll.fetchCloudProviders
   * @param {string} apiToken
   * @param {string} accountId
   * @param {string} gatewayId
   * @param {object} provider
   * @param {number} [maxRetries=3]
   * @returns {Promise<{ ok: boolean, cloudAction?: string, error?: string }>}
   */
  async function deleteWithVerify(deleteFn, fetchFn, apiToken, accountId, gatewayId, provider, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 1. 删除
      const r = await deleteFn(apiToken, accountId, gatewayId, provider)
      if (!r.ok) {
        // 404 → 云端已不存在
        if (r.error?.status === 404) return { ok: true, cloudAction: 'not-found' }
        // 其他错误，非最后一次则重试
        if (attempt < maxRetries) {
          console.log(`[provider-delete] ${provider.id} delete attempt ${attempt} failed (${r.error?.message || r.reason}), retrying...`)
          await new Promise(r => setTimeout(r, 1000))
          continue
        }
        return { ok: false, error: r.error instanceof Error ? r.error.message : (r.reason || 'cloud delete failed') }
      }

      // 2. 等待后验证
      await new Promise(r => setTimeout(r, 1000))
      try {
        const cloudResult = await fetchFn(apiToken, accountId, gatewayId)
        const stillExists = cloudResult.providers.some(p => p.id === provider.id)
        if (!stillExists) return { ok: true, cloudAction: 'deleted' }

        console.log(`[provider-delete] ${provider.id} still present after delete attempt ${attempt}, retrying...`)
      } catch {
        // 验证拉取失败：无法确认，但删除已返回成功，视为成功
        console.log(`[provider-delete] ${provider.id} delete OK but verify fetch failed, accepting as success`)
        return { ok: true, cloudAction: 'deleted' }
      }
    }

    return { ok: false, error: `删除后验证失败：${provider.id} 在 ${maxRetries} 次尝试后仍存在于云端，请在 Cloudflare Dashboard 手动确认` }
  }

  // POST /api/providers/delete — 删除 provider（云端 + 本地同步删除）。
  // [云端已删]（合并视图 mark==='removed'）条目仅移除本地，不触网；
  // 其余按 buildCloudDeleteParams 判定：缺 cloudId（本地缓存旧数据）→ 400 提示刷新。
  app.post('/api/providers/delete', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    if (typeof body.id !== 'string' || !body.id) {
      return c.json({ error: 'id is required' }, 400)
    }
    const config = configStore.load()
    let local = Array.isArray(config.providers) ? config.providers : []
    const provider = local.find((p) => p.id === body.id)
    // 幂等删除：provider 已不存在 → 视为删除成功（避免前端缓存过期时报错）
    if (!provider) return c.json({ ok: true, removed: true, cloudAction: 'already-gone' })

    const gateway = config.gateway || {}
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || depsAll.readManagementToken()

    // 「云端已删」判定：有 Token 且 gateway 就绪时拉云端合并视图，
    // mark==='removed'（云端已无该条目）→ 仅本地移除
    let cloudDeleted = false
    let cloudAction = 'unknown' // 返回前端，供日志展示云端删除结果
    if (mgmtToken && gateway.accountId && gateway.gatewayId) {
      try {
        const cloudResult = await depsAll.fetchCloudProviders(mgmtToken, gateway.accountId, gateway.gatewayId)
        const merged = depsAll.mergeProviderViews(local, cloudResult)
        cloudDeleted = merged.providers.find((p) => p.id === body.id)?.mark === 'removed'
        if (cloudDeleted) cloudAction = 'skipped-already-removed'
      } catch {
        // 拉取失败：回退 buildCloudDeleteParams 判定（有 cloudId 仍尝试云端删除）
      }
    }

    if (!cloudDeleted) {
      const built = buildCloudDeleteParams(provider)
      if (built.ok) {
        if (!mgmtToken) return c.json({ error: 'management token not configured' }, 400)
        const dr = await deleteWithVerify(
          depsAll.deleteProviderCloud, depsAll.fetchCloudProviders,
          mgmtToken, gateway.accountId, gateway.gatewayId, provider
        )
        if (!dr.ok) return c.json({ error: dr.error }, 400)
        cloudDeleted = true
        cloudAction = dr.cloudAction
      } else if (mgmtToken) {
        // 本地缺 cloudId 但云端仍存在该条目（正常条目）→ 提示先刷新拉取云端
        return c.json({ error: built.reason }, 400)
      }
      // 无 Token（离线）且无 cloudId → 仅本地移除（缓存降级）
      if (!cloudDeleted) cloudAction = 'offline-only'
    }

    // 本地移除 + 写盘
    console.log(`[provider-delete] ${body.id} type=${provider.type} cloudAction=${cloudAction}`)
    const hadPathPrefix = Boolean(provider.pathPrefix)
    local = followDelete(local, body.id)
    depsAll.writeProvidersConfigFile(local)

    // 级联删除该 provider 下所有模型（state 中 provider 字段即为 gateway slug）
    const providerSlug = gatewaySlug(provider)
    const modelsToDelete = Object.entries(state)
      .filter(([, entry]) => entry.provider === providerSlug)
      .map(([modelId]) => modelId)
    let modelsDeleted = 0
    if (modelsToDelete.length > 0) {
      for (const modelId of modelsToDelete) {
        delete state[modelId]
      }
      stateStore.save(state)
      try {
        depsAll.writeModelsJson(state)
      } catch {
        // models.json 写入失败不影响删除结果
      }
      modelsDeleted = modelsToDelete.length
      console.log(`[provider-delete] 级联删除 ${modelsDeleted} 个模型 (provider=${providerSlug})`)
      console.warn(`[provider-delete] 本地模型列表已更新，Worker 模型列表接口需「保存并部署」后才会同步`)
    }

    // KV 同步：被删 provider 带 pathPrefix → 重推 provider-routes 摘除；
    // 同时重写 provider-visibility（摘除已删条目，跨 PC 一致）。
    // 失败不影响删除结果（本地/云端已删），前端提示可在模型页重试。
    let kvDeployed = true
    let kvSkipped = false
    let kvError = null
    const namespaceId = config.kv?.namespaceId || ''
    const tryKv = async (fn) => {
      try {
        const r = await fn()
        if (r && r.skipped) { kvDeployed = false; kvSkipped = true }
        else if (r && r.success === false) { kvDeployed = false; kvError = r.output || 'KV 部署失败' }
      } catch (err) {
        kvDeployed = false
        kvError = err instanceof Error ? err.message : String(err)
      }
    }
    if (hadPathPrefix) {
      await tryKv(() => depsAll.deployProviderRoutesToKV({ ...config, providers: local }))
    }
    // 可见性：只要 KV 可用就重写（删掉该 id）；无 namespaceId 则 skipped
    if (mgmtToken && gateway.accountId && namespaceId) {
      await tryKv(() => depsAll.writeKvVisibility(
        mgmtToken, gateway.accountId, namespaceId, buildVisibilityMap(local)
      ))
    }
    return c.json({ ok: true, removed: true, cloudAction, modelsDeleted, kvDeployed, kvSkipped, kvError })
  })

  // ─── 任务 29：Worker + 账户管理 API（注册在静态文件中间件之前）───

  // GET /api/workers/status — Worker 部署状态（平铺字段 + buildWorkersStatus 完整结构）
  app.get('/api/workers/status', async (c) => {
    const config = configStore.load()
    const namespaceId = (config && config.kv && config.kv.namespaceId) || ''
    const key = (config && config.kv && config.kv.key) || 'models'
    const mj = depsAll.loadModelsJsonState()
    // namespaceId 为空（未配置 KV）→ 短路为 skipped，不调 checkKVKey（免触网）
    const kvStatus = namespaceId ? await depsAll.checkKVKey(namespaceId, key) : 'skipped'
    const status = depsAll.buildWorkersStatus({ namespaceId, modelsJson: mj, kvKey: kvStatus, kvKeyName: key })
    return c.json({
      ok: true,
      namespaceId,
      modelsJsonExists: status.modelsJson.exists,
      modelCount: status.modelsJson.count,
      kvKeyExists: kvStatus === 'exists',
      canDeploy: status.canDeploy,
      ...status,
    })
  })

  // POST /api/workers/deploy — 部署 Worker（spawn scripts/deploy.mjs deploy，捕获 stdout+stderr）
  // 退出码 0 → { ok:true, exitCode, output }；非 0 → HTTP 200 { ok:false, exitCode, output }
  // （业务失败 ≠ HTTP 错误，与 save-deploy 决策一致）；超时 → kill + 500 { error:'deploy timeout' }
  app.post('/api/workers/deploy', async (c) => {
    const config = configStore.load()
    const namespaceId = (config && config.kv && config.kv.namespaceId) || ''
    if (!namespaceId) return c.json({ error: 'kv namespace not configured' }, 400)
    const timeoutMs = depsAll.deployTimeoutMs ?? 120_000
    const child = depsAll.spawnFn(process.execPath, [SCRIPTS_DEPLOY_PATH, 'deploy'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const { exitCode, output } = await new Promise((resolve, reject) => {
      const chunks = []
      for (const name of ['stdout', 'stderr']) {
        const stream = child[name]
        if (stream && typeof stream.on === 'function') {
          if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8')
          stream.on('data', (chunk) => chunks.push(String(chunk)))
        }
      }
      const timer = setTimeout(() => {
        try {
          child.kill && child.kill()
        } catch {
          /* kill 失败不影响超时结果 */
        }
        reject(new Error('deploy timeout'))
      }, timeoutMs)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code, output: chunks.join('') })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    if (exitCode === 0) return c.json({ ok: true, exitCode, output })
    return c.json({ ok: false, exitCode, output })
  })

  // GET /api/account/status — 账户状态（双 token 槽位汇总 + gateway 信息）
  app.get('/api/account/status', async (c) => {
    const tokens = depsAll.summarizeTokenStatus({
      envManagement: process.env.CLOUDFLARE_API_TOKEN,
      envGateway: process.env.GATEWAY_TOKEN,
      localManagement: depsAll.readManagementToken(),
      localGateway: depsAll.readToken(),
    })
    const gateway = depsAll.summarizeGatewayInfo(configStore.load().gateway)
    return c.json({ ok: true, tokens, gateway })
  })

  // POST /api/account/update-token — 更新 Token 槽位（结果透传 updateToken 语义）
  app.post('/api/account/update-token', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    const slot = body.slot
    if (slot !== SLOTS.MANAGEMENT && slot !== SLOTS.GATEWAY) {
      return c.json({ error: `invalid slot: ${slot}（可用 management / gateway）` }, 400)
    }
    if (typeof body.token !== 'string') {
      return c.json({ error: 'token is required' }, 400)
    }
    // 空 / 空白 token → 取消（{ ok:false, skipped:true }，HTTP 200），与 updateToken 语义一致
    if (!body.token.trim()) {
      return c.json({ ok: false, skipped: true })
    }
    const r = depsAll.updateToken(slot, body.token)
    if (r.ok) return c.json({ ok: true, slot })
    if (r.skipped) return c.json({ ok: false, skipped: true })
    return c.json({ ok: false, error: r.error instanceof Error ? r.error.message : String(r.error) })
  })

  // POST /api/account/clear-token — 清除 Token 槽位（附影响面文案 IMPACT_TEXT[slot]）
  app.post('/api/account/clear-token', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: 'invalid json body' }, 400)
    const slot = body.slot
    if (slot !== SLOTS.MANAGEMENT && slot !== SLOTS.GATEWAY) {
      return c.json({ error: `invalid slot: ${slot}（可用 management / gateway）` }, 400)
    }
    const r = depsAll.clearSlotToken(slot)
    if (!r.ok) {
      const msg = r.error instanceof Error ? r.error.message : 'clear failed'
      return c.json({ error: msg }, 500)
    }
    return c.json({ ok: true, cleared: slot, impact: IMPACT_TEXT[slot] })
  })

  // POST /api/account/setup — 触发初始化向导（spawn aigd setup，stdio inherit，
  // 立即返回 started:true；向导交互在服务器终端进行，这是本机工具的设计）
  app.post('/api/account/setup', (c) => {
    try {
      depsAll.spawnFn(process.execPath, [AIGD_BIN_PATH, 'setup'], { stdio: 'inherit' })
    } catch (err) {
      return c.json({ error: err.message || 'spawn failed' }, 500)
    }
    return c.json({ ok: true, started: true })
  })

  // 静态文件：/ → index.html；存在文件 → 内容；缺失 → 404；root 外路径穿越自带防护
  // 无缓存头时浏览器启发式缓存可能长期复用旧版 app.js/index.html（前端零构建无指纹，
  // 服务端代码更新后界面仍是旧版——用户反馈「Provider 视图无刷新按钮」即旧版缓存症状），
  // 显式 no-cache 强制每次重新校验，避免此问题。
  app.get('*', async (c, next) => {
    c.header('Cache-Control', 'no-cache')
    await next()
  }, serveStatic({ root: publicDir }))
  return app
}

/**
 * 构造「打开浏览器」的平台命令（纯函数，可单测）。
 * @param {string} platform process.platform 值：'win32' | 'darwin' | 其他(视为 linux)
 * @param {string} url
 * @returns {string[]} 命令参数数组，例如 ['cmd', '/c', 'start', '', url]
 */
export function buildOpenCommand(platform, url) {
  if (platform === 'win32') return ['cmd', '/c', 'start', '', url]
  if (platform === 'darwin') return ['open', url]
  return ['xdg-open', url]
}

/**
 * 异步打开浏览器（不等待、不阻塞）。spawn 失败静默（.on('error', () => {})）。
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.platform] 缺省 process.platform
 * @param {Function} [options.spawnFn] 缺省 node:child_process 的 spawn（测试注入 mock）
 * @returns {void}
 */
export function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const args = buildOpenCommand(platform, url)
  const child = spawnFn(args[0], args.slice(1), { stdio: 'ignore' })
  // xdg-open 等命令不存在时 spawn 触发 error 事件，不处理会崩进程
  child.on('error', () => {})
}

/**
 * 启动 HTTP 服务器并（可选）自动打开浏览器。注册 SIGINT/SIGTERM 优雅关闭；
 * 心跳自动退出（桌面应用式关闭语义）：收到过心跳后若长时间无心跳，或收到
 * goodbye（pagehide/sendBeacon）后宽限期内无新心跳，服务器自动关闭退出。
 * @param {object} [options]
 * @param {number} [options.port=0]        0 = 随机端口
 * @param {string} [options.hostname='127.0.0.1']
 * @param {boolean} [options.openBrowser=true] 启动后自动打开浏览器
 * @param {Function} [options.openFn]       实际执行打开的函数，缺省 openBrowser（测试注入 mock）
 * @param {boolean} [options.installSignalHandlers=true] 注册 SIGINT/SIGTERM（测试可关）
 * @param {number} [options.heartbeatTimeout=15000]
 *        心跳超时（ms），超过则自动退出；<=0 禁用自动退出。
 *        从未收到心跳（curl / 未打开页面）不自动退出
 * @param {number} [options.heartbeatCheckInterval=1000] 超时检查周期（ms，测试可缩短）
 * @param {Function} [options.exitFn=process.exit] 退出函数（测试注入 mock 验证退出路径）
 * @returns {Promise<{ server, port:number, url:string, close:Function }>}
 *          close() 关闭服务器并移除信号监听器与心跳定时器（幂等，可多次调用）
 */
export function startServer(options = {}) {
  const {
    port = 0,
    hostname = '127.0.0.1',
    openBrowser: shouldOpen = true,
    openFn = openBrowser,
    installSignalHandlers = true,
    heartbeatTimeout = DEFAULT_HEARTBEAT_TIMEOUT,
    heartbeatCheckInterval = HEARTBEAT_CHECK_INTERVAL,
    exitFn = process.exit,
  } = options

  // 心跳状态由 startServer 创建并注入 createApp（直接 createApp 无状态 → 路由 no-op）
  const heartbeatState = { lastHeartbeat: null, goodbyeAt: null }
  const app = createApp({ heartbeatState })
  const signalListeners = []

  return new Promise((resolve, reject) => {
    // serve 同步返回 http.Server；实际端口（port:0 随机）在监听回调 info.port 里
    const server = serve(
      { fetch: app.fetch, port, hostname },
      (info) => {
        const actualPort = info.port
        const url = `http://${hostname}:${actualPort}`
        if (shouldOpen) openFn(url)

        let closed = false
        let heartbeatTimer = null
        const close = () =>
          new Promise((res) => {
            if (closed) return res()
            closed = true
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            for (const fn of signalListeners) {
              process.removeListener('SIGINT', fn)
              process.removeListener('SIGTERM', fn)
            }
            server.close(() => res())
          })

        // 心跳监控：从未收到心跳（curl / 无前端页面）不自动退出；收到过心跳后
        // 超时无心跳，或 goodbye 后宽限内无新心跳（刷新场景被新页面首心跳取消），
        // 视为浏览器页面全部关闭 → 自动退出（与桌面应用关闭语义一致）。
        if (heartbeatTimeout > 0) {
          heartbeatTimer = setInterval(() => {
            if (closed) return
            const now = Date.now()
            let reason = null
            if (heartbeatState.goodbyeAt && now - heartbeatState.goodbyeAt > GOODBYE_GRACE) {
              reason = '浏览器页面已全部关闭'
            } else if (heartbeatState.lastHeartbeat && now - heartbeatState.lastHeartbeat > heartbeatTimeout) {
              reason = '浏览器心跳超时（页面已关闭）'
            }
            if (reason) {
              console.log(`[aigd] ${reason}，服务器自动退出`)
              close().then(() => exitFn(0))
            }
          }, heartbeatCheckInterval)
        }

        if (installSignalHandlers) {
          const onSignal = () => {
            close().then(() => process.exit(0))
          }
          signalListeners.push(onSignal)
          process.on('SIGINT', onSignal)
          process.on('SIGTERM', onSignal)
        }

        resolve({ server, port: actualPort, url, close })
      }
    )
    server.on('error', reject)
  })
}

// ─── CLI 入口保护 ────────────────────────────────────────
// 被 aigd.js import 时 process.argv[1] 是 aigd.js，不会误启动；
// 仅 node src/web/server.js 直接运行时启动。简单路径比较即可。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename

if (isMain) {
  startServer({ openBrowser: !process.env.AIGD_NO_OPEN })
    .then(({ url }) => {
      console.log(`[aigd] Web 管理界面已启动: ${url}`)
      console.log('按 Ctrl+C 退出')
    })
    .catch((err) => {
      console.error('[aigd] Web 服务器启动失败:', err)
      process.exit(1)
    })
}
