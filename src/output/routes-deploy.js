import {
  createDynamicRoute,
  createDynamicRouteVersion,
  createDynamicRouteDeployment,
  listDynamicRoutes,
} from '../cloudflare/api.js'

/**
 * 动态路由部署编排：确保路由存在 → 提交版本 → 部署版本生效。
 *
 * 与 KV 部署（deploy.js）同为 output 层；差异在于走管理 REST API 而非 wrangler。
 * API 函数全部可注入（默认绑定 api.js），测试 mock 即可覆盖编排逻辑。
 *
 * @module ai-gateway-desk/src/output/routes-deploy
 */

/**
 * 从版本创建响应中提取版本号（防御多形态响应结构）。
 * 依次探测 result.version / result.id / data.version / data.id / 顶层 version / id。
 * @param {object} resp - createDynamicRouteVersion 响应体
 * @returns {number|string|null}
 */
export function normalizeVersionId(resp) {
  const candidates = [
    resp?.result?.version,
    resp?.result?.version_id,
    resp?.result?.versionId,
    resp?.result?.id,
    resp?.data?.version,
    resp?.data?.version_id,
    resp?.data?.id,
    resp?.version,
    resp?.version_id,
    resp?.id,
  ]
  for (const v of candidates) {
    if (typeof v === 'number' || (typeof v === 'string' && v.trim())) return v
  }
  return null
}

/**
 * 从 listDynamicRoutes 结果中按路由名查找云端路由
 * @param {Array<object>} routes - listDynamicRoutes 返回数组
 * @param {string} name - 路由名（如 "support"）
 * @returns {object|null} 命中的路由列表项（含 id）
 */
export function findRouteBySlug(routes, name) {
  if (!Array.isArray(routes) || !name) return null
  return routes.find((r) => r && typeof r.name === 'string' && r.name === name) || null
}

/**
 * 部署一条路由（创建缺失 → 提交版本 → 部署生效）
 *
 * @param {string} apiToken - 管理 API Token（账户级）
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {object} entry - 本地路由条目 { name, elements, cloudId? }
 * @param {object} [fns] - API 函数注入（测试 mock；缺省绑定 api.js）
 * @returns {Promise<{ ok: true, cloudId: string, version: number|string, created: boolean } |
 *                    { ok: false, error: string }>}
 */
export async function deployRouteConfig(apiToken, accountId, gatewayId, entry, fns = {}) {
  const fnsAll = {
    createDynamicRoute,
    createDynamicRouteVersion,
    createDynamicRouteDeployment,
    listDynamicRoutes,
    ...fns,
  }
  const { name, elements } = entry || {}
  if (!name || !Array.isArray(elements)) {
    return { ok: false, error: 'entry 缺少 name 或 elements' }
  }
  // Cloudflare 7001 防御：末级 model 也必须带 fallback→END，历史数据可能缺该字段
  // 仅当检测到缺口时深拷贝补齐，避免无变更时破坏调用方引用相等性（测试断言 elements === ELEMENTS）
  const normalizedElements = (() => {
    let needsPatch = false
    for (const n of elements) {
      if (n?.type === 'model') {
        const out = n.outputs || {}
        if (!out.success || typeof out.success.elementId !== 'string' || !out.success.elementId.trim()) { needsPatch = true; break }
        if (!out.fallback || typeof out.fallback.elementId !== 'string' || !out.fallback.elementId.trim()) { needsPatch = true; break }
      }
    }
    if (!needsPatch) return elements
    const copy = JSON.parse(JSON.stringify(elements))
    const byId = new Map(copy.filter((n) => n && typeof n.id === 'string').map((n) => [n.id, n]))
    const hasEnd = byId.has('END')
    for (const n of copy) {
      if (n?.type === 'model') {
        const out = n.outputs || (n.outputs = {})
        if (!out.success || typeof out.success.elementId !== 'string' || !out.success.elementId.trim()) {
          out.success = { elementId: 'END' }
        }
        if (!out.fallback || typeof out.fallback.elementId !== 'string' || !out.fallback.elementId.trim()) {
          out.fallback = { elementId: hasEnd ? 'END' : out.success.elementId }
        }
      }
    }
    return copy
  })()

  // ── 1. 确保路由壳存在 ──
  let cloudId = entry.cloudId || null
  let created = false
  if (cloudId) {
    // 已有 cloudId：直接复用；版本提交 404（云端已删）时回退重建（下方 catch）
  } else {
    try {
      const createdRoute = await fnsAll.createDynamicRoute(apiToken, accountId, gatewayId, { id: name, name, elements: normalizedElements })
      cloudId = createdRoute?.id || name // 创建响应缺 id 时以 name 兜底（与创建参数一致）
      created = true
    } catch (err) {
      // 409 = 已存在：从列表查回真实 id
      const status = err?.status
      if (status !== 409) {
        return { ok: false, error: `创建路由失败：${err instanceof Error ? err.message : String(err)}` }
      }
      const routes = await fnsAll.listDynamicRoutes(apiToken, accountId, gatewayId)
      const existing = findRouteBySlug(routes, name)
      if (!existing?.id) {
        return { ok: false, error: `路由 ${name} 已存在但未能从云端列表取回 id` }
      }
      cloudId = existing.id
    }
  }

  // ── 2. 提交版本 ──
  let versionResp
  try {
    versionResp = await fnsAll.createDynamicRouteVersion(apiToken, accountId, gatewayId, cloudId, normalizedElements)
  } catch (err) {
    // cloudId 失效（云端已删 / 手动重建）→ 404 时重建路由壳后重试一次
    if (err?.status === 404 && !created) {
      try {
        const recreated = await fnsAll.createDynamicRoute(apiToken, accountId, gatewayId, { id: name, name, elements: normalizedElements })
        cloudId = recreated?.id || name
        versionResp = await fnsAll.createDynamicRouteVersion(apiToken, accountId, gatewayId, cloudId, normalizedElements)
      } catch (retryErr) {
        return { ok: false, error: `提交版本失败（重建后仍失败）：${retryErr instanceof Error ? retryErr.message : String(retryErr)}` }
      }
    } else {
      return { ok: false, error: `提交版本失败：${err instanceof Error ? err.message : String(err)}` }
    }
  }
  const version = normalizeVersionId(versionResp)
  if (version == null) {
    return { ok: false, error: '版本提交成功但响应中未识别出版本号（无法部署）' }
  }

  // ── 3. 部署版本 ──
  try {
    await fnsAll.createDynamicRouteDeployment(apiToken, accountId, gatewayId, cloudId, { version })
  } catch (err) {
    return { ok: false, error: `部署版本失败：${err instanceof Error ? err.message : String(err)}` }
  }

  return { ok: true, cloudId, version, created }
}
