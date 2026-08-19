/**
 * Cloudflare REST API 封装模块
 * @module ai-gateway-desk/src/cloudflare/api
 *
 * 用途：封装 TUI 所需的 Cloudflare REST API 调用，供 setup 向导（任务 11）、
 *       provider 列表同步（任务 14）等后续功能使用。
 *
 * 凭证：所有函数第一个参数均为 apiToken（管理 Token，账户级），
 *       与 gateway token（cfut_xxx，绑定单个 gateway）职责不同，勿混用。
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'
const FETCH_TIMEOUT = 30_000 // 30 秒超时

// ─── 错误类型 ────────────────────────────────────────────

/**
 * Cloudflare API 错误
 * 非 2xx 响应时抛出，携带 HTTP status 与 Cloudflare 返回的错误明细
 * @property {number} status - HTTP 状态码（如 401 / 403 / 409 / 404）
 * @property {Array<{ code: number, message: string }>} errors - Cloudflare errors 数组
 */
export class CloudflareAPIError extends Error {
  constructor(status, message, errors = []) {
    super(message)
    this.name = 'CloudflareAPIError'
    this.status = status
    this.errors = errors
  }
}

// ─── 内部工具 ────────────────────────────────────────────

/**
 * 带超时的 fetch
 * @param {string} url
 * @param {object} options
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`请求超时 (${timeoutMs / 1000}s): ${url}`))
    }, timeoutMs)

    fetch(url, { ...options, signal: controller.signal })
      .then((res) => {
        clearTimeout(timer)
        resolve(res)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

/**
 * 由 HTTP 状态码 + 响应体构造 CloudflareAPIError
 * 优先取 Cloudflare errors 数组中的错误信息，否则回退到 HTTP 状态文本
 * @param {number} status
 * @param {object|null} payload - 解析后的响应体（可能为 null）
 * @returns {CloudflareAPIError}
 */
function createAPIError(status, payload) {
  const cfErrors = Array.isArray(payload?.errors) ? payload.errors : []
  if (cfErrors.length > 0) {
    const message = cfErrors
      .map((e) => (e.code != null ? `${e.code}: ${e.message ?? ''}` : e.message ?? ''))
      .join('; ')
    return new CloudflareAPIError(status, message || `HTTP ${status}`, cfErrors)
  }
  return new CloudflareAPIError(status, `HTTP ${status}`)
}

/**
 * 必填参数校验
 * @param {*} value
 * @param {string} name - 参数名（用于错误提示）
 * @throws {TypeError} 参数缺失或为空字符串时
 */
function guard(value, name) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new TypeError(`缺少必填参数: ${name}`)
  }
}

/**
 * 统一的 Cloudflare API 请求入口
 * - 自动携带 Authorization: Bearer {apiToken}
 * - 非 2xx 时抛出 CloudflareAPIError（含 status + 响应体错误信息）
 * @param {string} apiToken - 管理 API Token（账户级）
 * @param {string} path - API 路径（如 /accounts/{id}/ai-gateway/gateways）
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body] - 请求体（自动 JSON 序列化）
 * @param {number} [options.timeoutMs=30000]
 * @returns {Promise<object|null>} 解析后的响应体（204 等无内容时返回 null）
 */
async function request(apiToken, path, { method = 'GET', body, timeoutMs = FETCH_TIMEOUT } = {}) {
  guard(apiToken, 'apiToken')

  const url = `${API_BASE}${path}`
  const headers = {
    'Authorization': `Bearer ${apiToken}`,
    'Accept': 'application/json',
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const response = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    timeoutMs
  )

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    throw createAPIError(response.status, payload)
  }

  return payload
}

// ─── AI Gateway 管理 ─────────────────────────────────────

/**
 * 创建 AI Gateway（幂等：已存在时返回现有 gateway）
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - 要创建的 gateway id（如 "cf-ai-gateway"）
 * @returns {Promise<object>} gateway 对象（含 id / authentication 等）
 */
export async function createGateway(apiToken, accountId, gatewayId) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')

  try {
    const payload = await request(
      apiToken,
      `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways`,
      {
        method: 'POST',
        body: { id: gatewayId, authentication: true },
      }
    )
    return payload?.result
  } catch (err) {
    // 已存在时（409）视为成功，返回现有 gateway
    if (err instanceof CloudflareAPIError && err.status === 409) {
      return getGateway(apiToken, accountId, gatewayId)
    }
    throw err
  }
}

/**
 * 获取 gateway 信息（用于校验是否存在）
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @returns {Promise<object>} gateway 对象
 */
export async function getGateway(apiToken, accountId, gatewayId) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}`
  )
  return payload?.result
}

// ─── BYOK Provider Config ────────────────────────────────

/**
 * 存储 BYOK 厂商 Key（provider_configs）
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {object} config
 * @param {string} config.providerSlug - 厂商 slug（如 "openai"）
 * @param {string} config.secret - 厂商 API Key（BYOK）
 * @param {string} [config.alias] - 别名（默认用 providerSlug）
 * @returns {Promise<object>} provider_config 对象
 */
export async function createProviderConfig(apiToken, accountId, gatewayId, { providerSlug, secret, alias } = {}) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')
  guard(providerSlug, 'providerSlug')
  guard(secret, 'secret')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs`,
    {
      method: 'POST',
      body: {
        provider_slug: providerSlug,
        secret,
        alias: alias ?? providerSlug,
        default_config: false,
      },
    }
  )
  return payload?.result
}

/**
 * 列出该 gateway 下已存的 BYOK 厂商配置
 * 注意：secret 不会返回，仅返回 provider_slug / alias 等元信息
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @returns {Promise<Array<object>>} provider_configs 数组
 */
export async function listProviderConfigs(apiToken, accountId, gatewayId) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs`
  )
  return payload?.result ?? []
}

/**
 * 删除指定 provider 的 BYOK 配置（清理用）
 *
 * ⚠️ 2026-08-09 实测修正：DELETE /provider_configs/{slug} 返回 404（错误码 7002），
 * **必须用 provider_config 的 UUID id 删除**（GET 列表每项的 id 字段，非 provider_slug）。
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {string} id - provider_config 的 UUID（fetchCloudProviders 返回的 cloudId）
 * @returns {Promise<object|null>} 删除结果（204 无内容时为 null）
 */
export async function deleteProviderConfig(apiToken, accountId, gatewayId, id) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')
  guard(id, 'id')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
  return payload?.result ?? null
}

/**
 * 更新 BYOK provider_config（PUT，任务 20 实测确认端点存在）
 *
 * ⚠️ 2026-08-19 实测修正：PUT /provider_configs/{slug} 返回 7001 "Invalid uuid"
 * （与 DELETE 同类问题，见 deleteProviderConfig）——**路径必须用 provider_config
 * 的 UUID id**（GET 列表每项的 id 字段 / fetchCloudProviders 返回的 cloudId），
 * slug 仅作为 body 的 provider_slug 字段提交。
 *
 * 注意：**secret 为必填字段**（实测缺 secret 返回 400 "Required"），而云端不会
 * 回传完整 secret（仅 secret_preview 掩码）——因此本端点实际用于「覆盖 Key」：
 * 用户输入新 key 时以新 secret PUT，可同时更新 alias（name）与 secret。
 * 单独改名（无新 key）云端不支持，由调用方（provider-actions.js）提示。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {string} id - provider_config 的 UUID（fetchCloudProviders 返回的 cloudId）
 * @param {object} [changes]
 * @param {string} changes.providerSlug - 厂商 slug（如 "openai"，body 必填）
 * @param {string} [changes.secret] - 新厂商 API Key（必填，覆盖旧值）
 * @param {string} [changes.alias] - 别名（默认保持原值）
 * @returns {Promise<object>} 更新后的 provider_config 对象
 */
export async function updateProviderConfig(apiToken, accountId, gatewayId, id, { providerSlug, secret, alias } = {}) {
  guard(accountId, 'accountId')
  guard(gatewayId, 'gatewayId')
  guard(id, 'id')
  guard(providerSlug, 'providerSlug')
  guard(secret, 'secret')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs/${encodeURIComponent(id)}`,
    {
      method: 'PUT',
      body: {
        provider_slug: providerSlug,
        secret,
        ...(alias !== undefined ? { alias } : {}),
      },
    }
  )
  return payload?.result
}

// ─── Custom Provider ─────────────────────────────────────

/**
 * 创建 Custom Provider
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {object} config
 * @param {string} config.name - 显示名称（如 "Agnes"）
 * @param {string} config.slug - 唯一 slug（如 "custom-agnes"）
 * @param {string} config.baseUrl - 上游 base URL
 * @param {object} [config.headers] - 额外请求头（如 { Authorization: 'Bearer ...' }）
 * @param {boolean} [config.enable=true] - 是否启用
 * @returns {Promise<object>} custom provider 对象（含 id / slug / base_url / enable）
 */
export async function createCustomProvider(apiToken, accountId, { name, slug, baseUrl, headers, enable = true } = {}) {
  guard(accountId, 'accountId')
  guard(name, 'name')
  guard(slug, 'slug')
  guard(baseUrl, 'baseUrl')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/custom-providers`,
    {
      method: 'POST',
      body: {
        name,
        slug,
        base_url: baseUrl,
        // 实测（2026-08-18）：Cloudflare 要求 headers 为 JSON 字符串
        // （对象/空对象均 400 7001 'Expected string, received object'），
        // 空对象也不可发送 → headers 未提供时整字段省略。
        ...(headers !== undefined ? { headers: JSON.stringify(headers) } : {}),
        enable,
      },
    }
  )
  return payload?.result
}

/**
 * 列出账户下全部 Custom Provider
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @returns {Promise<Array<object>>} custom providers 数组（每项含 id / name / slug / base_url / enable）
 */
export async function listCustomProviders(apiToken, accountId) {
  guard(accountId, 'accountId')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/custom-providers`
  )
  return payload?.result ?? []
}

/**
 * 更新 Custom Provider（PATCH，任务 20 实测确认端点存在）
 *
 * 支持更新 name / enable（云端开关）/ base_url / headers。只提交非 undefined
 * 字段，未提供的字段云端保持不变——因此「api key 覆盖」可只传 headers。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} id - custom provider 的 id（UUID）
 * @param {object} [changes]
 * @param {string} [changes.name] - 显示名称
 * @param {boolean} [changes.enable] - 云端启用状态
 * @param {string} [changes.baseUrl] - 上游 base URL
 * @param {object} [changes.headers] - 额外请求头（覆盖时传完整 headers，含 Authorization）
 * @returns {Promise<object>} 更新后的 custom provider 对象
 */
export async function updateCustomProvider(apiToken, accountId, id, { name, enable, baseUrl, headers } = {}) {
  guard(accountId, 'accountId')
  guard(id, 'id')

  const body = {}
  if (name !== undefined) body.name = name
  if (enable !== undefined) body.enable = enable
  if (baseUrl !== undefined) body.base_url = baseUrl
  // 与 createCustomProvider 一致：云端 headers 字段为 JSON 字符串
  if (headers !== undefined) body.headers = JSON.stringify(headers)

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/custom-providers/${encodeURIComponent(id)}`,
    { method: 'PATCH', body }
  )
  return payload?.result
}

/**
 * 删除指定 Custom Provider（清理用）
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} id - custom provider 的 id（UUID）
 * @returns {Promise<object|null>} 删除结果（204 无内容时为 null）
 */
export async function deleteCustomProvider(apiToken, accountId, id) {
  guard(accountId, 'accountId')
  guard(id, 'id')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/ai-gateway/custom-providers/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  )
  return payload?.result ?? null
}

// ─── KV Namespace ────────────────────────────────────────

/**
 * 创建 KV namespace
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} title - namespace 标题（如 "models-kv"）
 * @returns {Promise<{ id: string, title: string }>} 创建的 namespace
 */
export async function createKVNamespace(apiToken, accountId, title) {
  guard(accountId, 'accountId')
  guard(title, 'title')

  const payload = await request(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
    {
      method: 'POST',
      body: { title },
    }
  )
  return payload?.result
}
