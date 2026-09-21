/**
 * Worker 访问地址自动发现
 * @module ai-gateway-desk/src/cloudflare/worker-endpoints
 *
 * 通过 Cloudflare 稳定版 API 聚合本项目 Worker 的三类真实可达地址：
 *   - workersDev：workers.dev 默认地址（账户子域 + 脚本开启访问时才有值）
 *   - customDomains：通过 Workers Domains（Custom Domains）绑定的域名
 *   - routes：通过 Workers Routes（zone 路由模式，如 *.example.com/api/*）推导出的地址
 *
 * 地址仅用于网关页展示与引导 Agent 直连，本地进程不会请求这些地址。
 */

import {
  WORKER_SCRIPT_NAME,
  getWorkersSubdomain,
  getWorkerScriptSubdomainEnabled,
  listWorkerDomains,
  listZones,
  listWorkerRoutes,
} from './api.js'

export const ROUTE_WILDCARD_PLACEHOLDER = '<子域>'

/**
 * 拼接 workers.dev 默认地址
 * @param {string} subdomain - 账户 workers.dev 子域名
 * @param {string} scriptName - Worker 脚本名
 * @returns {string} 完整 https 地址；子域为空时返回空串
 */
export function buildWorkersDevUrl(subdomain, scriptName = WORKER_SCRIPT_NAME) {
  const sub = typeof subdomain === 'string' ? subdomain.trim() : ''
  if (!sub) return ''
  return `https://${scriptName}.${sub}.workers.dev`
}

/**
 * 将 Workers Route 模式转换为 Agent Base URL
 *
 * 模式形如 `*.example.com/api/*`（host 部分可带前导通配符，path 部分可带尾部 `/*`）：
 *   - host 首段 `*` → 以 <子域> 占位（需用户替换成真实子域）
 *   - path 尾部 `/*` 或 `*` → 去掉，剩余路径前缀保留
 *   - 末尾统一补 /v1
 * @param {string} pattern - 路由模式
 * @returns {string} Base URL；无法解析时返回空串
 */
export function routePatternToBaseUrl(pattern) {
  const raw = typeof pattern === 'string' ? pattern.trim() : ''
  if (!raw) return ''

  const slashAt = raw.indexOf('/')
  const hostPart = slashAt === -1 ? raw : raw.slice(0, slashAt)
  const pathPart = slashAt === -1 ? '' : raw.slice(slashAt)

  let host = hostPart.trim()
  if (host.startsWith('*.')) {
    host = `${ROUTE_WILDCARD_PLACEHOLDER}.${host.slice(2)}`
  } else if (host === '*') {
    host = ROUTE_WILDCARD_PLACEHOLDER
  }
  if (!host || host.includes('*')) return ''

  let pathPrefix = pathPart
  if (pathPrefix.endsWith('/*')) {
    pathPrefix = pathPrefix.slice(0, -2)
  } else if (pathPrefix.endsWith('*')) {
    pathPrefix = pathPrefix.slice(0, -1)
  }
  if (pathPrefix !== '' && !pathPrefix.startsWith('/')) pathPrefix = `/${pathPrefix}`
  pathPrefix = pathPrefix.replace(/\/+$/, '')

  return `https://${host}${pathPrefix}/v1`
}

/**
 * 发现 Worker 的全部访问地址
 *
 * 三组发现各自容错：workers.dev（两次查询）、Custom Domains、Workers Routes
 * （先列 zone 再逐 zone 列路由）。单点失败只令对应字段留空并记入 error，
 * 不抛出、不拖垮其他发现。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {object} [deps] - 注入 API 实现（测试用）
 * @returns {Promise<{workersDev: string, customDomains: string[], routes: string[], error: string}>}
 */
export async function discoverWorkerEndpoints(
  apiToken,
  accountId,
  deps = {}
) {
  const {
    getSubdomain = getWorkersSubdomain,
    getScriptEnabled = getWorkerScriptSubdomainEnabled,
    getDomains = listWorkerDomains,
    getZones = listZones,
    getRoutes = listWorkerRoutes,
  } = deps

  const errors = []

  let workersDev = ''
  try {
    const subdomain = await getSubdomain(apiToken, accountId)
    const enabled = await getScriptEnabled(apiToken, accountId)
    if (enabled) workersDev = buildWorkersDevUrl(subdomain)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  let customDomains = []
  try {
    customDomains = await getDomains(apiToken, accountId)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  let routes = []
  try {
    const zones = await getZones(apiToken, accountId)
    const patterns = []
    for (const zone of Array.isArray(zones) ? zones : []) {
      if (!zone?.id) continue
      const zonePatterns = await getRoutes(apiToken, zone.id)
      for (const p of Array.isArray(zonePatterns) ? zonePatterns : []) {
        const baseUrl = routePatternToBaseUrl(p)
        if (baseUrl && !patterns.includes(baseUrl)) patterns.push(baseUrl)
      }
    }
    routes = patterns
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }

  return {
    workersDev,
    customDomains: Array.isArray(customDomains) ? customDomains : [],
    routes,
    error: errors.join('; '),
  }
}
