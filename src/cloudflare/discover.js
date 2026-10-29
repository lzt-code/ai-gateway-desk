/**
 * 模型发现模块 — 遍历启用的 provider，通过 AI Gateway 获取 /v1/models 列表
 *
 * 网络要点：单个 provider 请求的超时覆盖「连接 + 读响应体」全程（只等响应头时，
 * 正文卡住的请求会让 discover 阶段无限期挂住）；各 provider 并发且失败互相隔离。
 * 请求/响应明细统一走 core/io-logger（操作名 discover:models:<slug> /
 * discover:routes:dynamic），debug 关闭时终端只留每条结果日志。
 * @module ai-gateway-desk/src/cloudflare/discover
 */

import { listDynamicRoutes, getDynamicRouteDetail } from './api.js'
import { withNetworkRetry, describeNetworkError } from '../core/net-retry.js'
import { logRequest, logResponse, logResult } from '../core/io-logger.js'
import { normalizePathPrefix } from '../gateway/router.js'

const FETCH_TIMEOUT = 15_000 // 15 秒超时

/**
 * 归一化动态路由的目标模型链（route.model 字段）
 *
 * Cloudflare 管理 API 返回的 route.model 可能是：
 *   - 字符串（直连单个模型，无 fallback）→ 归一化为单元素数组
 *   - 字符串数组（fallback 顺序链，数组顺序即尝试顺序）→ 过滤空值后原样保留
 *   - 缺失 / 其他类型（如未命名默认路由）→ undefined（前端显示为「未指定」）
 *
 * @param {unknown} model - route 对象的 model 字段
 * @returns {string[]|undefined} 归一化后的模型链（至少一个非空字符串），无有效值时 undefined
 */
export function normalizeRouteModelChain(model) {
  if (typeof model === 'string') {
    const s = model.trim()
    return s ? [s] : undefined
  }
  if (Array.isArray(model)) {
    const chain = model.filter((m) => typeof m === 'string' && m.trim() !== '')
    return chain.length > 0 ? chain : undefined
  }
  return undefined
}

/**
 * 解析动态路由详情 version.data 流程图 → fallback 模型链
 *
 * Cloudflare 路由详情的 version.data 是节点数组（2026-09-01 实测）：
 *   - { id: 'START', type: 'start', outputs.next.elementId } → 首个模型节点
 *   - { type: 'model', properties: { provider, model },
 *       outputs: { success → END, fallback → 下一级模型节点 } }
 *   - { id: 'END', type: 'end' }
 * 链 = 从 START 沿 next 进入首个 model 节点，再沿 fallback 逐级走到底。
 *
 * @param {unknown} versionData - 路由详情 result.version.data（节点数组）
 * @returns {string[]|undefined} 形如 ['provider-a/model-x', 'provider-b/model-y']
 *   的尝试顺序链（至少一级），无法解析（旧版结构/脏数据/无模型节点）时 undefined
 */
export function parseRouteFallbackChain(versionData) {
  if (!Array.isArray(versionData)) return undefined
  const byId = new Map()
  for (const node of versionData) {
    if (node && typeof node === 'object' && typeof node.id === 'string') byId.set(node.id, node)
  }
  const start = byId.get('START')
  const firstId = start && start.outputs && start.outputs.next && start.outputs.next.elementId
  let cur = typeof firstId === 'string' ? byId.get(firstId) : null
  const chain = []
  const visited = new Set() // 防环：fallback 指回已访问节点时立即终止
  while (cur && cur.type === 'model' && !visited.has(cur.id)) {
    visited.add(cur.id)
    const provider = cur.properties && cur.properties.provider
    const model = cur.properties && cur.properties.model
    if (typeof provider === 'string' && provider.trim() && typeof model === 'string' && model.trim()) {
      chain.push(`${provider.trim()}/${model.trim()}`)
    }
    const nextId = cur.outputs && cur.outputs.fallback && cur.outputs.fallback.elementId
    cur = typeof nextId === 'string' ? byId.get(nextId) : null
  }
  return chain.length > 0 ? chain : undefined
}

// SSE debug 事件的响应体预览长度上限，避免大 JSON（OpenRouter 全量模型可达
// 数 MB）塞爆前端 200 行日志栏；统一日志器的 debug 响应体同样按 1KB 截断
const DEBUG_BODY_PREVIEW_LIMIT = 1000

/**
 * token 脱敏：保留首尾 4 字符，中间以 * 填充（与 cloudflare/api.js maskToken 同策略）
 * @param {string} token
 * @returns {string}
 */
function maskToken(token) {
  const s = String(token)
  if (s.length <= 8) return '*'.repeat(s.length)
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`
}

/**
 * 请求头脱敏：authorization 类头保留认证 scheme（如 "Bearer "），token 打码；
 * 其余头原样返回
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function maskHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/authorization/i.test(k)) {
      const s = String(v)
      const m = s.match(/^(\S+\s+)(.+)$/)
      out[k] = m ? `${m[1]}${maskToken(m[2])}` : maskToken(s)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 从非 2xx 响应体文本提取错误描述（AI Gateway 错误体如
 * {"error":[{"code":2008,"message":"Invalid provider"}], "message": "..."}）
 * @param {number} status
 * @param {string} statusText
 * @param {string} text 响应体原文
 * @returns {string} 如 "400 Bad Request: Invalid provider"
 */
function errorDetailFromText(status, statusText, text) {
  const base = `${status} ${statusText}`
  try {
    const body = JSON.parse(text)
    const msg =
      body?.error?.[0]?.message ||
      body?.message ||
      (typeof body?.error === 'string' ? body.error : null)
    return msg ? `${base}: ${msg}` : base
  } catch {
    return base
  }
}

/**
 * 带超时的文本 GET（请求/响应细节走统一 IO 日志器）
 *
 * 超时覆盖「连接 + 读响应体」全过程：只覆盖响应头时，正文传输卡住的请求会
 * 无限期等待（大模型列表 / 上游降速），整个 discover 阶段会挂住不再前进。
 *
 * @param {string} url
 * @param {object} options
 * @param {string} options.operation - 日志操作名（域:动作:目标）
 * @param {string} [options.method='GET']
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs=FETCH_TIMEOUT]
 * @returns {Promise<{ ok: boolean, status: number, statusText: string, headers: Record<string,string>|null, text: string, bytes: number, elapsedMs: number }>}
 */
async function fetchTextWithTimeout(url, { operation, method = 'GET', headers, timeoutMs = FETCH_TIMEOUT } = {}) {
  const start = Date.now()
  logRequest(operation, { method, url, headers })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = null
  try {
    const res = await fetch(url, { method, headers, signal: controller.signal })
    status = res.status
    // 响应体只读一次（text），debug / 错误详情 / JSON 解析共用原文；
    // 读取仍在同一个 abort 定时器内，正文卡住同样会按时超时
    const text = await res.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    const elapsedMs = Date.now() - start
    const responseHeaders =
      res.headers && typeof res.headers.entries === 'function' ? Object.fromEntries(res.headers.entries()) : null
    logResponse(operation, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders || undefined,
      body: text,
      bytes,
      elapsedMs,
      truncated: text.length > DEBUG_BODY_PREVIEW_LIMIT,
    })
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: responseHeaders, text, bytes, elapsedMs }
  } catch (err) {
    const elapsedMs = Date.now() - start
    const timedOut = controller.signal.aborted
    if (timedOut) {
      const message = `请求超时 (${timeoutMs / 1000}s): ${url}`
      logResponse(operation, { status, output: message, elapsedMs })
      // 超时不是连接阶段错误：不重试、不再等一轮，直接失败
      throw new Error(message)
    }
    logResponse(operation, { status, output: describeNetworkError(err, url), elapsedMs })
    // 其余错误原样抛出：交由 withNetworkRetry 判断是否重试、由调用方展开文案
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 给模型 id 加上 provider 前缀（如果原始 id 没有前缀的话）
 * @param {string} modelId - 原始模型 id
 * @param {string} providerSlug - 网关路由 slug（如 "custom-agnes"）
 * @returns {string} 带前缀的模型 id
 */
function prefixModelId(modelId, providerSlug) {
  if (modelId.startsWith(`${providerSlug}/`)) {
    return modelId
  }
  return `${providerSlug}/${modelId}`
}

/**
 * 计算 AI Gateway 路由 slug：
 *   - custom provider 必须带 custom- 前缀（官方文档规则：请求 URL 用 custom-{slug}）
 *     例如 { id: 'agnes', type: 'custom-provider' } → 'custom-agnes'
 *   - byok 直接用 id（官方 provider slug，如 openai / openrouter / deepseek）
 * 注意：providers.json 里 custom provider 的 id 是 Cloudflare API 的 slug（不带前缀），
 *       前缀只是网关 URL 路由规则；模型 id 前缀也用本 slug，保证与 Agent 端配置一致。
 * @param {{ id: string, type?: string }} provider
 * @returns {string}
 */
export function gatewaySlug(provider) {
  if (provider?.type === 'custom-provider' && !String(provider.id).startsWith('custom-')) {
    return `custom-${provider.id}`
  }
  return provider.id
}

/**
 * 遍历启用的 provider，通过 AI Gateway fetch /v1/models，收集结果
 *
 * 可选 onProgress 回调（模型发现时显示每个 provider 拉取进度）：
 *   - 请求发出前触发一次 { status: 'pending' }
 *   - 每个 provider 完成（成功/失败）后触发一次 { status: 'done'|'error' }
 *   - config.debug === true 时额外触发 { status: 'debug', debug: {...} }：
 *       phase 'request' → { method, url, headers }（authorization 头已脱敏）
 *       phase 'response' → { httpStatus, statusText, headers, bytes, elapsedMs,
 *                            bodyPreview, truncated }（响应体截断预览，全文见服务器终端）
 *   done/total 为已完成数 / 总数（按完成顺序递增；debug 事件不计数）
 *
 * @param {object} config - loadConfig() 返回的配置对象；config.debug === true 开启详细日志
 * @param {string} gatewayToken - Cloudflare AI Gateway token
 * @param {(p: { provider: string, status: 'pending'|'done'|'error'|'debug', models?: number, error?: string, debug?: object, done: number, total: number }) => void} [onProgress] - 可选进度回调
 * @param {string} [providerFilter] - 可选：只拉取指定 provider（按网关 slug 或原始 id 匹配）。
 *   传入时仅发现该 provider，merge 阶段也只对其模型执行「未发现→移除」规则（见 merge.js discoveredProviders 限定）。
 *   传入 'dynamic' 时仅拉取动态路由。
 *   未匹配任何启用 provider → 返回空结果（不抛错），与「无启用 Provider」语义一致。
 * @param {string} [mgmtToken] - 可选：管理 API Token（账户级）。传入时额外拉取 AI Gateway
 *   动态路由列表，作为虚拟 "dynamic" provider 加入结果。动态路由模型 id 为
 *   "dynamic/<route-name>"，通过 compat 端点调用（worker 自动路由）。
 * @returns {Promise<{ results: Array<{ provider: string, models: Array<object> }>, errors: Array<{ provider: string, error: string }> }>}
 */
export async function discoverModels(config, gatewayToken, onProgress, providerFilter, mgmtToken) {
  const { gateway, providers } = config
  const debug = config?.debug === true
  let enabledProviders = providers.filter((p) => p.enabled)

  // 判断是否拉取动态路由（需要管理 Token；单 Provider 模式仅当 filter='dynamic' 时拉取）
  const fetchRoutes = !!mgmtToken && (!providerFilter || providerFilter === 'dynamic')

  if (providerFilter) {
    enabledProviders = enabledProviders.filter(
      (p) => gatewaySlug(p) === providerFilter || p.id === providerFilter
    )
    if (enabledProviders.length === 0 && !fetchRoutes) {
      console.log(`[discover] providerFilter "${providerFilter}" 无匹配的启用 Provider，跳过模型发现`)
      return { results: [], errors: [] }
    }
    if (enabledProviders.length > 0) {
      console.log(`[discover] 单 Provider 模式：仅拉取 ${enabledProviders.map((p) => gatewaySlug(p)).join(', ')}`)
    }
  }

  if (enabledProviders.length === 0 && !fetchRoutes) {
    console.log('[discover] 无启用的 Provider，跳过模型发现')
    return { results: [], errors: [] }
  }

  const baseUrl = `https://${gateway.host}/v1/${gateway.accountId}/${gateway.gatewayId}`
  const startTime = Date.now()
  const total = enabledProviders.length + (fetchRoutes ? 1 : 0)
  console.log(`[discover] 开始拉取模型列表 — Gateway: ${gateway.host}/${gateway.gatewayId}，启用 Provider 数: ${enabledProviders.length}${fetchRoutes ? ' + 动态路由' : ''}`)
  for (const p of enabledProviders) {
    console.log(`[discover]   Provider: ${p.id} (${p.type || 'byok'})`)
  }

  let finished = 0

  const requests = enabledProviders.map(async (provider) => {
    const slug = gatewaySlug(provider)
    const providerStartTime = Date.now()
    if (onProgress) onProgress({ provider: slug, status: 'pending', done: finished, total })
    // pathPrefix 可能手写成不带前导 /（如 "api/paas/v4"），必须归一化，
    // 否则会拼成 ".../custom-glmapi/paas/v4/models"（slug 与前缀粘连 → 网关 502）
    const prefix = normalizePathPrefix(provider.pathPrefix)
    const modelPath = prefix ? `${prefix}/models` : '/v1/models'
    const url = `${baseUrl}/${slug}${modelPath}`
    const method = 'GET'
    const headers = {
      'cf-aig-authorization': `Bearer ${gatewayToken}`,
      'Accept': 'application/json',
    }
    // debug 事件统一出口（config.debug 开启且调用方传了回调才发）
    const emitDebug = (payload) => {
      if (debug && onProgress) {
        onProgress({ provider: slug, status: 'debug', debug: payload, done: finished, total })
      }
    }

    const op = `discover:models:${slug}`
    try {
      // 请求/响应明细由统一日志器输出（debug 关闭时终端只留结果日志），
      // 这里只负责把脱敏后的调用详情作为 debug 事件推给前端
      if (debug) {
        emitDebug({ phase: 'request', method, url, headers: maskHeaders(headers) })
      }

      const response = await withNetworkRetry(
        () => fetchTextWithTimeout(url, { operation: op, method, headers }),
        {
          onRetry: ({ attempt, waitMs, detail }) =>
            logResult(op, {
              ok: false,
              message: `连接失败，${waitMs}ms 后第 ${attempt} 次重试 — ${detail}`,
              elapsedMs: Date.now() - providerStartTime,
            }),
        }
      ).catch((err) => {
        // 连接阶段最终失败：把 "fetch failed" 展开为根因 + 主机，避免笼统文案
        throw new Error(describeNetworkError(err, url), { cause: err })
      })
      const { status, statusText, text, bytes } = response
      const respElapsed = Date.now() - providerStartTime

      if (debug) {
        emitDebug({
          phase: 'response',
          httpStatus: status,
          statusText,
          headers: response.headers || {},
          bytes,
          elapsedMs: respElapsed,
          truncated: text.length > DEBUG_BODY_PREVIEW_LIMIT,
          bodyPreview: text.slice(0, DEBUG_BODY_PREVIEW_LIMIT),
        })
      }

      if (!response.ok) {
        // 优先透出网关错误细节（如 400 Invalid provider），便于定位配置问题
        throw new Error(errorDetailFromText(status, statusText, text))
      }

      let body
      try {
        body = JSON.parse(text)
      } catch {
        const snippet = text.slice(0, 120).replace(/\s+/g, ' ')
        throw new Error(`响应不是合法 JSON: ${snippet}`)
      }

      // 兼容两种响应格式（实测）：
      //   - OpenAI 标准：{ object: 'list', data: [...] }（custom provider 上游）
      //   - OpenRouter 原生：{ data: [...] }（无 object 字段）
      const data = Array.isArray(body?.data) ? body.data : null
      if (!data) {
        const keys = body ? Object.keys(body).join(',') : 'empty'
        throw new Error(`返回格式异常: 缺少 data 数组 (keys=${keys})`)
      }

      // 给每个模型 id 加上网关 slug 前缀（与 Agent 端调用 compat 端点时用的模型名一致）
      const models = data.map((model) => ({
        ...model,
        id: prefixModelId(model.id, slug),
      }))

      const elapsed = Date.now() - providerStartTime
      const sampleIds = models.slice(0, 3).map((m) => m.id).join(', ')
      logResult(op, {
        ok: true,
        message: `HTTP ${status} — ${models.length} 个模型${models.length > 0 ? `（${sampleIds}${models.length > 3 ? '…' : ''}）` : ''}`,
        elapsedMs: elapsed,
      })

      finished++
      if (onProgress) onProgress({ provider: slug, status: 'done', models: models.length, done: finished, total })
      return { provider: slug, models }
    } catch (err) {
      finished++
      const error = err instanceof Error ? err.message : String(err)
      const elapsed = Date.now() - providerStartTime
      logResult(op, { ok: false, message: error, elapsedMs: elapsed })
      if (onProgress) onProgress({ provider: slug, status: 'error', error, done: finished, total })
      throw err
    }
  })

  const settled = await Promise.allSettled(requests)

  const results = []
  const errors = []

  for (let i = 0; i < settled.length; i++) {
    const item = settled[i]
    const providerId = enabledProviders[i].id

    if (item.status === 'fulfilled') {
      results.push(item.value)
    } else {
      const reason = item.reason
      errors.push({
        provider: providerId,
        error: reason instanceof Error ? reason.message : String(reason),
      })
    }
  }

  // ─── 拉取动态路由（作为虚拟 "dynamic" provider） ───
  // 动态路由通过管理 API 获取（需 mgmtToken），不经过 AI Gateway /v1/models 端点。
  // 路由名作为模型 id 前缀 "dynamic/<name>"，worker 通过 compat 端点自动路由。
  if (fetchRoutes) {
    const slug = 'dynamic'
    const routeStartTime = Date.now()
    const op = 'discover:routes:dynamic'
    if (onProgress) onProgress({ provider: slug, status: 'pending', done: finished, total })

    try {
      const routes = await listDynamicRoutes(mgmtToken, gateway.accountId, gateway.gatewayId)

      // 列表端点不含 fallback 链，需逐条拉详情（version.data 流程图）。
      // N+1 调用但路由数通常个位数；单条详情失败只丢该条链信息，不中断同步
      const details = await Promise.all(
        routes.map((r) =>
          r && typeof r.id === 'string' && r.id
            ? getDynamicRouteDetail(mgmtToken, gateway.accountId, gateway.gatewayId, r.id).catch(() => null)
            : Promise.resolve(null),
        ),
      )

      const models = routes
        .filter((r) => r && typeof r.name === 'string' && r.name.trim())
        .map((route, i) => {
          const detail = details[i]
          // 链来源优先级：详情流程图（实测唯一来源）→ 列表 route.model 字段（容错，
          // 当前 API 不返回该字段，保留兼容未来 API 直接下发链的场景）
          const chain =
            parseRouteFallbackChain(detail && detail.version && detail.version.data) ||
            normalizeRouteModelChain(route.model)
          return {
            id: `dynamic/${route.name}`,
            object: 'model',
            name: route.name,
            ...(route.created_at ? { created: Math.floor(new Date(route.created_at).getTime() / 1000) } : {}),
            owned_by: '动态路由',
            // fallback 链（provider/model 数组，顺序即尝试顺序）；缺失时不写字段，
            // 前端动态路由视图对无链数据按「无链信息」降级展示
            ...(chain ? { route_models: chain } : {}),
          }
        })

      const elapsed = Date.now() - routeStartTime
      const sampleIds = models.slice(0, 3).map((m) => m.id).join(', ')
      logResult(op, {
        ok: true,
        message: `HTTP 管理 API — ${models.length} 个动态路由${models.length > 0 ? `（${sampleIds}${models.length > 3 ? '…' : ''}）` : ''}`,
        elapsedMs: elapsed,
      })

      finished++
      if (onProgress) onProgress({ provider: slug, status: 'done', models: models.length, done: finished, total })
      results.push({ provider: slug, models })
    } catch (err) {
      finished++
      const error = err instanceof Error ? err.message : String(err)
      const elapsed = Date.now() - routeStartTime
      logResult(op, { ok: false, message: error, elapsedMs: elapsed })
      if (onProgress) onProgress({ provider: slug, status: 'error', error, done: finished, total })
      errors.push({ provider: slug, error })
    }
  }

  const totalElapsed = Date.now() - startTime
  const totalModels = results.reduce((sum, r) => sum + r.models.length, 0)
  const failedList = errors.map((e) => `${e.provider}（${e.error}）`).join('；')
  logResult('discover:models', {
    ok: errors.length === 0,
    message: `成功 ${results.length}/${total}，共 ${totalModels} 个模型${failedList ? ` — 失败: ${failedList}` : ''}`,
    elapsedMs: totalElapsed,
  })

  return { results, errors }
}

// 仅供测试：验证「连接 + 读响应体」全程超时语义（响应头到达后正文卡住也必须超时）
export { fetchTextWithTimeout as _fetchTextWithTimeout }
