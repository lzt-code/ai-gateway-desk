// ============================================================
// 网关路由纯函数 — slug 解析/剥离、厂商真实端点构造
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §4.1、§5）：
//   请求 body.model 形如 "<provider-slug>/<厂商模型名>"，其中：
//     - provider-slug：第一个 '/' 之前的部分（gatewaySlug，custom- 前缀）
//     - 厂商模型名：其余全部（自身也可能含 '/'，如 vercel/meta/xxx）
//   local 模式需剥离 slug，用 provider 的 base_url（+ pathPrefix）拼出
//   厂商真实 /chat/completions 端点，从本机出口 IP 直连。
//
// 本模块全部为纯函数，不触网络 / 不读文件，便于单测。
// ============================================================

/**
 * 内置 BYOK provider 的 OpenAI 兼容端点。
 * BYOK 在 Cloudflare 侧由其内部映射厂商地址，本地 providers.json 中
 * 无 base_url 字段，故本地直发需内置一份；条目自带 base_url 时优先用之。
 */
export const BYOK_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  perplexity: 'https://api.perplexity.ai',
}

/**
 * 解析 model 字段中的 provider slug 与上游模型名。
 * @param {unknown} model - body.model 字符串
 * @returns {{ slug: string, upstream: string }|null}
 *   如 'custom-ark/doubao/x' → { slug:'custom-ark', upstream:'doubao/x' }；
 *   非字符串 / 不含 '/' / slug 为空 → null
 */
export function parseModelSlug(model) {
  if (typeof model !== 'string' || !model) return null
  const idx = model.indexOf('/')
  if (idx <= 0) return null
  const slug = model.slice(0, idx)
  const upstream = model.slice(idx + 1)
  if (!upstream) return null
  return { slug, upstream }
}

/**
 * 剥离 body.model 中的 provider slug 前缀，返回新的 body 对象（不改入参）。
 * @param {object} body - 已解析的请求体
 * @param {string} slug - 要剥离的 provider slug
 * @returns {object} 处理后的请求体（无需剥离时原样返回同一对象）
 */
export function stripModelSlug(body, slug) {
  if (!body || typeof body !== 'object') return body
  const { model } = body
  if (typeof model !== 'string') return body
  const prefix = `${slug}/`
  if (!model.startsWith(prefix)) return body
  return { ...body, model: model.slice(prefix.length) }
}

/**
 * 归一化 base_url：必须 http(s)，去除尾部所有 '/'
 * @param {string} baseUrl
 * @returns {string}
 * @throws base_url 缺失 / 非 http(s) 时抛错
 */
export function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new Error('base_url 缺失')
  }
  let u
  try {
    u = new URL(baseUrl.trim())
  } catch {
    throw new Error(`base_url 非法: ${baseUrl}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`base_url 必须以 http:// 或 https:// 开头: ${baseUrl}`)
  }
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 归一化 pathPrefix：保证以 '/' 开头、无尾部 '/'；空值返回 ''
 * @param {unknown} pathPrefix
 * @returns {string}
 */
export function normalizePathPrefix(pathPrefix) {
  if (pathPrefix === undefined || pathPrefix === null) return ''
  if (typeof pathPrefix !== 'string') throw new Error('pathPrefix 必须是字符串')
  let p = pathPrefix.trim()
  if (!p) return ''
  if (!p.startsWith('/')) p = `/${p}`
  return p.replace(/\/+$/, '')
}

/**
 * 构造厂商真实 chat 端点：base_url + pathPrefix + /chat/completions
 * @param {string} baseUrl
 * @param {string} [pathPrefix]
 * @returns {string}
 */
export function buildVendorUrl(baseUrl, pathPrefix) {
  const base = normalizeBaseUrl(baseUrl)
  const prefix = normalizePathPrefix(pathPrefix)
  return `${base}${prefix}/chat/completions`
}

/**
 * 解析 provider 的本地直发端点。
 *
 * - custom-provider：使用条目 base_url（+ pathPrefix）
 * - byok：优先条目自带 base_url（+ pathPrefix），否则查内置 BYOK_BASE_URLS
 *
 * @param {object} provider - providers.json 中的 provider 条目
 * @returns {string} 厂商 /chat/completions 完整 URL
 * @throws 无法确定 base_url 时抛错（提示补录或让 Agent 直连 Cloudflare 网关）
 */
export function resolveProviderEndpoint(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('provider 条目为空')
  }
  const { id, type } = provider
  if (provider.base_url) {
    return buildVendorUrl(provider.base_url, provider.pathPrefix)
  }
  if (type === 'byok') {
    const builtin = BYOK_BASE_URLS[id]
    if (builtin) return buildVendorUrl(builtin, provider.pathPrefix)
  }
  throw new Error(
    `provider '${id}' 本地缺少 base_url，无法直发；请补录 base_url，或让 Agent 直连 Cloudflare 网关`
  )
}
