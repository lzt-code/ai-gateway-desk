/**
 * POST /chat/completions — 认证 + 转发到 AI Gateway
 *
 * 核心逻辑：只映射 header，不校验 token 内容、不存 key。
 * 关键映射：标准 Authorization -> cf-aig-authorization（真鉴权交给 AI Gateway）
 *
 * 路由策略：
 *   1. 读取请求体，提取 model 字段
 *   2. 解析 provider slug（model 中 '/' 之前的部分）
 *   3. 若 slug 匹配 provider-routes，使用 provider-specific 端点
 *      （适用于非标准 API 路径的 custom provider，如火山方舟的 /api/v3）
 *      此时剥离 model 中的 slug 前缀（URL 已含 slug，上游只需原始模型名）
 *   4. 否则使用 compat 端点（默认，兼容所有 OpenAI 兼容 provider），保留 slug
 *
 * @module ai-gateway-desk-worker/src/routes/chat
 */

import { getGatewayConfig } from '../config.js'
import { jsonResponse } from '../http.js'

/**
 * 从请求体 JSON 中提取 model 字段的 provider slug
 * @param {string} bodyText - 原始请求体文本
 * @returns {string|null} provider slug（如 "custom-ark"），未找到返回 null
 */
function extractProviderSlug(bodyText) {
  if (!bodyText) return null
  try {
    const body = JSON.parse(bodyText)
    const model = body?.model
    if (!model || typeof model !== 'string') return null
    const slashIdx = model.indexOf('/')
    if (slashIdx === -1) return null
    return model.substring(0, slashIdx)
  } catch {
    return null
  }
}

/**
 * 剥离 model 字段中的 provider slug 前缀。
 *
 * 仅在 provider-specific 端点使用——URL 路径已包含 slug，
 * 上游 provider 需要其原始模型名（如 "doubao-seed-evolving"）。
 *
 * @param {string} bodyText - 原始请求体文本
 * @param {string} slug - 要剥离的 provider slug
 * @returns {string} 修改后的请求体文本（若无法解析或无需修改则原样返回）
 */
function stripProviderSlug(bodyText, slug) {
  if (!bodyText || !slug) return bodyText
  try {
    const body = JSON.parse(bodyText)
    const model = body?.model
    if (typeof model !== 'string') return bodyText
    const prefix = `${slug}/`
    if (!model.startsWith(prefix)) return bodyText
    body.model = model.slice(prefix.length)
    return JSON.stringify(body)
  } catch {
    return bodyText
  }
}

/**
 * 处理 chat 请求
 * @param {Request} request
 * @param {object} env - Worker 环境（含 Gateway 配置变量）
 * @returns {Promise<Response>}
 */
export async function handleChat(request, env) {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Missing Authorization' }, 401)
  }

  // ─── 读取 Gateway 配置 ───
  let gateway
  try {
    gateway = getGatewayConfig(env)
  } catch {
    return jsonResponse(
      { error: '缺少 ACCOUNT_ID / GATEWAY_ID 环境变量，请在 wrangler.toml [vars] 或 secret 中配置' },
      500
    )
  }
  const { host, accountId, gatewayId } = gateway

  // ─── 读取请求体，确定路由 ───
  // 读取 body 文本（同时用于解析 model 和转发）
  const bodyText = await request.text()

  // 从 KV 读取 provider 路由映射（slug → pathPrefix）
  let customRoutes = {}
  try {
    const stored = await env.MODELS_KV.get('provider-routes', 'json')
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      customRoutes = stored
    }
  } catch {
    // KV 读取失败，使用空映射（回退 compat 端点）
  }

  const slug = extractProviderSlug(bodyText)
  const pathPrefix = slug ? customRoutes[slug] : null

  // 决定目标 URL；provider-specific 端点需要剥离 model 中的 slug 前缀
  let targetUrl
  let forwardBody = bodyText
  if (pathPrefix) {
    // 使用 provider-specific 端点
    // 路径构造：{slug}{pathPrefix}/chat/completions
    // 示例：custom-ark/api/v3/chat/completions
    targetUrl = `https://${host}/v1/${accountId}/${gatewayId}/${slug}${pathPrefix}/chat/completions`
    // URL 已含 slug，上游 provider 只需原始模型名（如 "doubao-seed-evolving"）
    forwardBody = stripProviderSlug(bodyText, slug)
  } else {
    // 默认使用 compat 端点（OpenAI 兼容），slug 用于 Gateway 内部路由，保留
    targetUrl = `https://${host}/v1/${accountId}/${gatewayId}/compat/chat/completions`
  }
  const target = new URL(targetUrl)

  // 创建新的 Headers，基于原始请求头（转发所有必要头）
  const headers = new Headers(request.headers)
  // 关键映射：标准 Authorization -> cf-aig-authorization
  headers.set('cf-aig-authorization', auth)
  headers.delete('Authorization')
  headers.set('Content-Type', 'application/json')

  // 打印调试信息到控制台（Wrangler 日志中可见）
  console.log(`Fetching POST ${target.toString()}`, {
    headers: Object.fromEntries(headers.entries()),
    route: pathPrefix ? 'provider-specific' : 'compat',
    slug: slug ?? '(none)',
    bodyRewritten: forwardBody !== bodyText,
  })

  // 转发请求（使用已读取的 bodyText，避免重复读取流）
  const response = await fetch(target.toString(), {
    method: 'POST',
    headers,
    body: forwardBody,
  })

  // 如果上游返回错误，也记录一下
  if (!response.ok) {
    console.error(`AI Gateway returned ${response.status}`, {
      status: response.status,
      statusText: response.statusText,
    })
  }

  return response
}
