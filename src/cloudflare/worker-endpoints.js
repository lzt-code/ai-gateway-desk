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
  listDnsRecords,
} from './api.js'

export const ROUTE_WILDCARD_PLACEHOLDER = '<子域>'

/** 去重追加一条提示（notes），空值忽略 */
function pushNote(notes, note) {
  const s = typeof note === 'string' ? note.trim() : ''
  if (s && !notes.includes(s)) notes.push(s)
}

/** 错误消息提取 */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

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
 * 解析 Workers Route 模式 → { host, wildcard, pathPrefix }
 *
 * 模式形如 `*.example.com/api/*`：
 *   - hostPart：第一个 `/` 之前的部分（host，可带前导 `*.` 或为裸 `*`）
 *   - pathPart：其余部分
 *   - wildcard：host 是否为通配（`*.example.com` / `*`）
 *   - host：剥离前导 `*.` 后的主机后缀（裸 `*` 时为空串）
 *   - pathPrefix：去掉尾部 `/*` 或 `*` 后的路径前缀（无则空串）
 *
 * 无法解析（空串 / 非法中段通配符，如 `a*.example.com`）时返回 null。
 * @param {string} pattern - 路由模式
 * @returns {{ host: string, wildcard: boolean, pathPrefix: string }|null}
 */
export function parseRoutePattern(pattern) {
  const raw = typeof pattern === 'string' ? pattern.trim() : ''
  if (!raw) return null

  const slashAt = raw.indexOf('/')
  const hostPart = slashAt === -1 ? raw : raw.slice(0, slashAt)
  const pathPart = slashAt === -1 ? '' : raw.slice(slashAt)

  let host = hostPart.trim()
  let wildcard = false
  if (host.startsWith('*.')) {
    wildcard = true
    host = host.slice(2)
  } else if (host === '*') {
    wildcard = true
    host = ''
  }
  if (host.includes('*')) return null

  let pathPrefix = pathPart
  if (pathPrefix.endsWith('/*')) {
    pathPrefix = pathPrefix.slice(0, -2)
  } else if (pathPrefix.endsWith('*')) {
    pathPrefix = pathPrefix.slice(0, -1)
  }
  if (pathPrefix !== '' && !pathPrefix.startsWith('/')) pathPrefix = `/${pathPrefix}`
  pathPrefix = pathPrefix.replace(/\/+$/, '')

  return { host, wildcard, pathPrefix }
}

/**
 * 将路由模式转换为 Agent Base URL
 *
 * 通配符 host 默认以 `<子域>` 占位（需用户替换）；也可通过 hostOverride 传入
 * 已解析出的真实子域（见 matchProxiedSubdomains）。路径末尾统一补 /v1。
 * @param {string} pattern - 路由模式
 * @param {string} [hostOverride] - 已解析的真实主机名；仅通配符模式下生效
 * @returns {string} Base URL；无法解析时返回空串
 */
export function routePatternToBaseUrl(pattern, hostOverride) {
  const parsed = parseRoutePattern(pattern)
  if (!parsed) return ''

  let host
  const override = typeof hostOverride === 'string' ? hostOverride.trim() : ''
  if (parsed.wildcard && override && !override.includes('*')) {
    host = override
  } else if (parsed.wildcard) {
    host = parsed.host
      ? `${ROUTE_WILDCARD_PLACEHOLDER}.${parsed.host}`
      : ROUTE_WILDCARD_PLACEHOLDER
  } else {
    host = parsed.host
  }
  if (!host || host.includes('*')) return ''

  return `https://${host}${parsed.pathPrefix}/v1`
}

/**
 * 在已代理 DNS 记录中解析通配符 host 对应的可用子域（纯函数）
 *
 * 规则：
 *   - 记录名 `*.<suffix>` → 标记 wildcardDns=true（任意子域可用），不作为具体子域
 *   - 其余记录须严格位于 suffix 之下（`x.suffix`，不含 suffix 本身与 zone 根域）
 *   - 仅 proxied=true 的记录参与；含 `*` 的非通配记录忽略
 *   - 裸 `*` 路由（host 为空）时以 zone 名为 suffix
 *
 * @param {string} host - parseRoutePattern().host（通配符已剥离；裸 * 时为空串）
 * @param {string} zoneName - zone 名（如 "example.com"）
 * @param {Array<{ name: string, proxied: boolean }>} records - 该 zone 的 DNS 记录
 * @returns {{ subdomains: string[], wildcardDns: boolean }} subdomains 已排序去重
 */
export function matchProxiedSubdomains(host, zoneName, records) {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : ''
  const zone = typeof zoneName === 'string' ? zoneName.trim().toLowerCase() : ''
  const suffix = h || zone

  const subdomains = []
  let wildcardDns = false

  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.proxied !== true || typeof r.name !== 'string') continue
    const name = r.name.trim().toLowerCase()
    if (!name) continue

    if (suffix && name === `*.${suffix}`) {
      wildcardDns = true
      continue
    }
    if (!suffix || !name.endsWith(`.${suffix}`)) continue
    if (name.includes('*')) continue
    if (!subdomains.includes(name)) subdomains.push(name)
  }

  subdomains.sort()
  return { subdomains, wildcardDns }
}

/**
 * 发现 Worker 的全部访问地址
 *
 * 三组发现各自容错：workers.dev（两次查询）、Custom Domains、Workers Routes
 * （先列 zone 再逐 zone 列路由；通配符 host 再查已代理 DNS 记录解析真实子域）。
 * 单点失败只令对应字段留空并记入 error，不抛出、不拖垮其他发现。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {object} [deps] - 注入 API 实现（测试用）
 * @returns {Promise<{workersDev: string, customDomains: string[], routes: string[], notes: string[], error: string}>}
 *   notes：路由通配符未能解析时的降级提示（非致命，前端以警告展示）
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
    getDnsRecords = listDnsRecords,
  } = deps

  const errors = []

  let workersDev = ''
  try {
    const subdomain = await getSubdomain(apiToken, accountId)
    const enabled = await getScriptEnabled(apiToken, accountId)
    if (enabled) workersDev = buildWorkersDevUrl(subdomain)
  } catch (err) {
    errors.push(errMessage(err))
  }

  let customDomains = []
  try {
    customDomains = await getDomains(apiToken, accountId)
  } catch (err) {
    errors.push(errMessage(err))
  }

  let routes = []
  const notes = []
  try {
    const zones = await getZones(apiToken, accountId)
    const seen = new Set()
    const addRoute = (url) => {
      if (url && !seen.has(url)) {
        seen.add(url)
        routes.push(url)
      }
    }

    for (const zone of Array.isArray(zones) ? zones : []) {
      if (!zone?.id) continue
      const zonePatterns = await getRoutes(apiToken, zone.id)
      const parsedPatterns = (Array.isArray(zonePatterns) ? zonePatterns : [])
        .map((p) => ({ pattern: p, parsed: parseRoutePattern(p) }))
        .filter((x) => x.parsed)
      if (parsedPatterns.length === 0) continue

      // 仅当存在通配符路由时才查 DNS（避免无谓调用 / 旧 Token 必然 403）
      const hasWildcard = parsedPatterns.some((x) => x.parsed.wildcard)
      let records = null
      let dnsError = null
      if (hasWildcard) {
        try {
          records = await getDnsRecords(apiToken, zone.id)
        } catch (err) {
          dnsError = err
        }
      }

      for (const { pattern, parsed } of parsedPatterns) {
        if (!parsed.wildcard) {
          addRoute(routePatternToBaseUrl(pattern))
          continue
        }

        if (records) {
          const { subdomains, wildcardDns } = matchProxiedSubdomains(
            parsed.host,
            zone.name,
            records
          )
          if (subdomains.length > 0) {
            for (const sub of subdomains) addRoute(routePatternToBaseUrl(pattern, sub))
            continue
          }
          addRoute(routePatternToBaseUrl(pattern))
          pushNote(
            notes,
            wildcardDns
              ? `路由 ${pattern}：DNS 已配置通配代理记录，任意子域均可用（请将 ${ROUTE_WILDCARD_PLACEHOLDER} 换为真实子域）`
              : `路由 ${pattern}：未找到已代理（橙云）的 DNS 记录，请先在 Cloudflare DNS 添加后刷新`
          )
        } else {
          addRoute(routePatternToBaseUrl(pattern))
          pushNote(
            notes,
            dnsError && dnsError.status === 403
              ? `路由 ${pattern} 未能自动解析 ${ROUTE_WILDCARD_PLACEHOLDER}：管理 Token 缺少 Zone → DNS → Read 权限`
              : `路由 ${pattern} 未能自动解析 ${ROUTE_WILDCARD_PLACEHOLDER}：${errMessage(dnsError)}`
          )
        }
      }
    }
  } catch (err) {
    errors.push(errMessage(err))
  }

  return {
    workersDev,
    customDomains: Array.isArray(customDomains) ? customDomains : [],
    routes,
    notes,
    error: errors.join('; '),
  }
}
