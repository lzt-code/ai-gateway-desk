// ============================================================
// 本地动态路由 fallback 引擎
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §10）：
//   执行 data/routes.json 中的 elements 图，语义对齐 Cloudflare
//   AI Gateway 平台行为：
//     1. 从 start 出发，进入首个 model 节点；
//     2. 每个 model 节点按自身 properties.timeout / retries 本地直发；
//     3. 可重试错误（网络失败 / 429 / 5xx）重试耗尽后走 fallback 边；
//     4. 收到 200 响应头即判定成功并开始向客户端返回；
//        4xx（非 429）立即报错，不回退；
//     5. percentage 节点按输出权重随机选择分支；
//     6. conditional / rate 等超出本地能力的图结构返回明确错误。
//
// 已知限制（与 CF 一致）：上游一旦返回 200，流式中途的错误无法再回退。
//
// 依赖全部经工厂参数注入，默认实现对齐生产环境，测试可整体 mock。
// ============================================================

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadRoutesStore as defaultLoadRoutesStore,
} from '../core/routes-store.js'
import {
  resolveProviderEndpoint,
  stripModelSlug,
} from './router.js'
import {
  findProvider as defaultFindProvider,
} from './provider-lookup.js'
import {
  readProviderHeaders as defaultReadProviderHeaders,
} from './provider-keys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 data/ */
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

const DEFAULT_TIMEOUT_MS = 120000

/**
 * 构造 JSON 错误响应
 * @param {number} status
 * @param {string} error
 * @returns {Response}
 */
function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 从 routes store 中按名称取出路由条目
 * @param {Record<string, object>|null|undefined} store
 * @param {string} name
 * @returns {object|null}
 */
export function findRouteEntry(store, name) {
  const routes = store?.routes
  if (!routes || typeof routes !== 'object') return null
  const entry = routes[name]
  return entry && typeof entry === 'object' ? entry : null
}

/**
 * 建立节点 id → 节点 的索引
 * @param {Array<object>} elements
 * @returns {Map<string, object>}
 */
export function indexElements(elements) {
  const map = new Map()
  if (!Array.isArray(elements)) return map
  for (const el of elements) {
    if (el && typeof el === 'object' && typeof el.id === 'string') {
      map.set(el.id, el)
    }
  }
  return map
}

/**
 * 本地引擎不支持的节点类型
 * @param {object} node
 * @returns {string|null} 不支持时返回中文提示，支持时返回 null
 */
export function unsupportedNodeError(node) {
  const type = node?.type
  if (type === 'conditional') {
    return '本地网关不支持 conditional（条件分支）图结构，该结构仅 Cloudflare 支持，请让 Agent 直连云端 Worker'
  }
  if (type === 'rate') {
    return '本地网关不支持 rate（限流）图结构，该结构仅 Cloudflare 支持，请让 Agent 直连云端 Worker'
  }
  return null
}

/**
 * percentage 节点：按输出权重随机选择一个输出端口
 * @param {object} node
 * @param {() => number} [random] - () => [0,1)，测试可注入固定值
 * @returns {{ port: string, weight: number } | Error}
 */
export function pickPercentageOutput(node, random = Math.random) {
  const entries = Object.entries(node?.outputs || {})
    .map(([port, target]) => ({ port, weight: parseFloat(port), target }))
    .filter((e) => Number.isFinite(e.weight) && e.weight > 0)
  if (entries.length === 0) {
    return new Error('percentage 节点缺少合法的权重输出')
  }
  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  let point = random() * total
  if (!(point >= 0) || point >= total) point = 0
  for (const entry of entries) {
    point -= entry.weight
    if (point < 0) return { port: entry.port, weight: entry.weight }
  }
  return { port: entries[0].port, weight: entries[0].weight }
}

/**
 * 判断上游响应是否为可重试 / 可回退的状态
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

/**
 * 创建本地 fallback 引擎
 * @param {object} [deps]
 * @param {string} [deps.dataDir]
 * @param {Function} [deps.loadRoutesStore] - (dataDir) => { routes }
 * @param {Function} [deps.fetchFn] - (url, init) => Promise<Response>
 * @param {Function} [deps.findProvider] - (slug, dataDir) => provider | null
 * @param {Function} [deps.readProviderHeaders] - (slug) => headers | null
 * @param {Function} [deps.random] - () => [0,1)
 */
export function createFallbackEngine(deps = {}) {
  const dataDir = deps.dataDir || DEFAULT_DATA_DIR
  const loadStore =
    deps.loadRoutesStore || (() => defaultLoadRoutesStore(dataDir))
  const fetchFn = deps.fetchFn || globalThis.fetch
  const findProvider = deps.findProvider || defaultFindProvider
  const readProviderHeaders = deps.readProviderHeaders || defaultReadProviderHeaders
  const random = deps.random || Math.random

  /**
   * 单个 model 节点的一次直发尝试
   * @param {object} node - model 节点
   * @param {object} body - 已解析的请求体
   * @returns {Promise<{ ok: true, response: Response } | { ok: false, error: string, status?: number }>}
   */
  async function attemptModel(node, body) {
    const props = node.properties || {}
    const slug = props.provider
    const upstreamModel = props.model

    const provider = findProvider(slug, dataDir)
    if (!provider) {
      return { ok: false, error: `本地配置中找不到 provider '${slug}'`, status: 400 }
    }

    let endpoint
    try {
      endpoint = resolveProviderEndpoint(provider)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: 400,
      }
    }

    const credentialHeaders = readProviderHeaders(slug)
    if (!credentialHeaders) {
      return {
        ok: false,
        error: `本地缺少 provider '${slug}' 的凭证，请回填 / 录入，或让 Agent 直连云端 Worker`,
        status: 400,
      }
    }

    const nodeTimeout =
      Number.isFinite(props.timeout) && props.timeout > 0
        ? props.timeout
        : DEFAULT_TIMEOUT_MS

    const forwardBody = JSON.stringify({
      ...stripModelSlug(body, 'dynamic'),
      model: upstreamModel,
    })
    const headers = new Headers(credentialHeaders)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'text/event-stream')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), nodeTimeout)
    try {
      const response = await fetchFn(endpoint, {
        method: 'POST',
        headers,
        body: forwardBody,
        signal: controller.signal,
      })
      return { ok: true, response }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return {
        ok: false,
        error: aborted
          ? `请求 provider '${slug}' 超时（${nodeTimeout}ms）`
          : `请求 provider '${slug}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 执行动态路由
   * @param {string} routeName - dynamic/<name> 中的 name
   * @param {object} body - 已解析的请求体
   * @returns {Promise<Response>}
   */
  async function execute(routeName, body) {
    let store
    try {
      store = loadStore(dataDir)
    } catch (err) {
      return jsonError(
        500,
        `读取路由配置失败: ${err instanceof Error ? err.message : String(err)}`
      )
    }

    const entry = findRouteEntry(store, routeName)
    if (!entry) {
      return jsonError(400, `本地路由中找不到动态路由 '${routeName}'`)
    }

    const elements = Array.isArray(entry.elements) ? entry.elements : []
    const byId = indexElements(elements)
    const start = elements.find((el) => el.type === 'start')
    if (!start) {
      return jsonError(400, `路由 '${routeName}' 缺少 start 节点`)
    }

    let nodeId = start.outputs?.next?.elementId
    const visited = new Set()
    const attemptsLog = []

    while (nodeId) {
      if (nodeId === 'END' || byId.get(nodeId)?.type === 'end') {
        return jsonError(502, `动态路由 '${routeName}' 所有候选均失败（已到 END）`)
      }
      if (visited.has(nodeId)) {
        return jsonError(500, `路由 '${routeName}' 存在环，本地引擎拒绝执行`)
      }
      visited.add(nodeId)

      const node = byId.get(nodeId)
      if (!node) {
        return jsonError(400, `路由 '${routeName}' 连线指向不存在的节点 ${nodeId}`)
      }

      const unsupported = unsupportedNodeError(node)
      if (unsupported) return jsonError(400, unsupported)

      if (node.type === 'percentage') {
        const picked = pickPercentageOutput(node, random)
        if (picked instanceof Error) {
          return jsonError(400, `路由 '${routeName}'：${picked.message}`)
        }
        nodeId = node.outputs[picked.port]?.elementId
        continue
      }

      if (node.type === 'start') {
        return jsonError(400, `路由 '${routeName}' 连线回到 start，图结构非法`)
      }

      if (node.type !== 'model') {
        return jsonError(
          400,
          `本地网关不支持 ${node.type} 图结构，该结构仅 Cloudflare 支持，请让 Agent 直连云端 Worker`
        )
      }

      const props = node.properties || {}
      const retries = Number.isInteger(props.retries) && props.retries > 0
        ? props.retries
        : 0
      const totalTries = retries + 1

      let lastFailure = null
      let terminal = null

      for (let attemptIndex = 0; attemptIndex < totalTries; attemptIndex++) {
        const result = await attemptModel(node, body)

        if (result.ok) {
          const { response } = result
          if (response.status === 200) {
            return response
          }
          if (isRetryableStatus(response.status)) {
            lastFailure = `provider '${props.provider}' 返回 ${response.status}`
            continue
          }
          terminal = response
          break
        }

        if (result.status === 400) {
          terminal = jsonError(400, result.error)
          break
        }
        lastFailure = result.error
      }

      if (terminal) return terminal

      attemptsLog.push({
        node: node.id,
        provider: props.provider,
        model: props.model,
        reason: lastFailure || '未知错误',
      })

      const fallbackId = node.outputs?.fallback?.elementId
      if (!fallbackId) {
        return jsonError(502, `动态路由 '${routeName}' 无可用 fallback：${lastFailure || ''}`)
      }
      nodeId = fallbackId
    }

    const detail = attemptsLog.map((a) => `${a.provider}: ${a.reason}`).join('；')
    return jsonError(
      502,
      `动态路由 '${routeName}' 所有候选均失败${detail ? `：${detail}` : ''}`
    )
  }

  return { type: 'fallback', execute }
}
