/**
 * 模型发现模块 — 遍历启用的 provider，通过 AI Gateway 获取 /v1/models 列表
 * @module ai-gateway-desk/src/cloudflare/discover
 */

const FETCH_TIMEOUT = 15_000 // 15 秒超时

/**
 * 从非 2xx 响应中提取错误描述（AI Gateway 错误体如
 * {"error":[{"code":2008,"message":"Invalid provider"}], "message": "..."}）
 * @param {Response} response
 * @returns {Promise<string>} 如 "400 Bad Request: Invalid provider"
 */
async function errorDetail(response) {
  const base = `${response.status} ${response.statusText}`
  try {
    const body = await response.json()
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
 * 可选 onProgress 回调（TUI 启动自动同步/按 F4 时显示每个 provider 拉取进度）：
 *   - 请求发出前触发一次 { status: 'pending' }
 *   - 每个 provider 完成（成功/失败）后触发一次 { status: 'done'|'error' }
 *   done/total 为已完成数 / 总数（按完成顺序递增）
 *
 * @param {object} config - loadConfig() 返回的配置对象
 * @param {string} gatewayToken - Cloudflare AI Gateway token
 * @param {(p: { provider: string, status: 'pending'|'done'|'error', models?: number, error?: string, done: number, total: number }) => void} [onProgress] - 可选进度回调
 * @returns {Promise<{ results: Array<{ provider: string, models: Array<object> }>, errors: Array<{ provider: string, error: string }> }>}
 */
export async function discoverModels(config, gatewayToken, onProgress) {
  const { gateway, providers } = config
  const enabledProviders = providers.filter((p) => p.enabled)

  if (enabledProviders.length === 0) {
    console.log('[discover] 无启用的 Provider，跳过模型发现')
    return { results: [], errors: [] }
  }

  const baseUrl = `https://${gateway.host}/v1/${gateway.accountId}/${gateway.gatewayId}`
  const startTime = Date.now()
  console.log(`[discover] 开始拉取模型列表 — Gateway: ${gateway.host}/${gateway.gatewayId}，启用 Provider 数: ${enabledProviders.length}`)
  for (const p of enabledProviders) {
    console.log(`[discover]   Provider: ${p.id} (${p.type || 'byok'})`)
  }

  let finished = 0
  const total = enabledProviders.length

  const requests = enabledProviders.map(async (provider) => {
    const slug = gatewaySlug(provider)
    const providerStartTime = Date.now()
    if (onProgress) onProgress({ provider: slug, status: 'pending', done: finished, total })
    try {
      // 如果 provider 配置了 pathPrefix（如方舟的 /api/v3），
      // 用它替换默认的 /v1 路径前缀，与 ai-gateway-desk-worker 路由逻辑一致
      const modelPath = provider.pathPrefix ? `${provider.pathPrefix}/models` : `/v1/models`
      const url = `${baseUrl}/${slug}${modelPath}`
      console.log(`[discover] 请求 [${slug}] GET ${url}`)

      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          'cf-aig-authorization': `Bearer ${gatewayToken}`,
          'Accept': 'application/json',
        },
      })

      if (!response.ok) {
        // 优先透出网关错误细节（如 400 Invalid provider），便于定位配置问题
        const errDetail = await errorDetail(response)
        console.log(`[discover] 失败 [${slug}] HTTP ${response.status}: ${errDetail}`)
        throw new Error(errDetail)
      }

      const body = await response.json()

      // 兼容两种响应格式（实测）：
      //   - OpenAI 标准：{ object: 'list', data: [...] }（custom provider 上游）
      //   - OpenRouter 原生：{ data: [...] }（无 object 字段）
      const data = Array.isArray(body?.data) ? body.data : null
      if (!data) {
        const keys = body ? Object.keys(body).join(',') : 'empty'
        console.log(`[discover] 失败 [${slug}] 返回格式异常: 缺少 data 数组 (keys=${keys})`)
        throw new Error(`返回格式异常: 缺少 data 数组 (keys=${keys})`)
      }

      // 给每个模型 id 加上网关 slug 前缀（与 Agent 端调用 compat 端点时用的模型名一致）
      const models = data.map((model) => ({
        ...model,
        id: prefixModelId(model.id, slug),
      }))

      const elapsed = Date.now() - providerStartTime
      console.log(`[discover] 成功 [${slug}] 获取 ${models.length} 个模型 (${elapsed}ms)`)
      if (models.length > 0) {
        const sampleIds = models.slice(0, 3).map((m) => m.id).join(', ')
        console.log(`[discover] 模型示例 [${slug}]: ${sampleIds}${models.length > 3 ? '…' : ''}`)
      }

      finished++
      if (onProgress) onProgress({ provider: slug, status: 'done', models: models.length, done: finished, total })
      return { provider: slug, models }
    } catch (err) {
      finished++
      const error = err instanceof Error ? err.message : String(err)
      const elapsed = Date.now() - providerStartTime
      console.log(`[discover] 失败 [${slug}] ${error} (${elapsed}ms)`)
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

  const totalElapsed = Date.now() - startTime
  const totalModels = results.reduce((sum, r) => sum + r.models.length, 0)
  console.log(`[discover] 拉取完成 — 成功 ${results.length}/${total}，共 ${totalModels} 个模型 (${totalElapsed}ms)`)
  if (errors.length > 0) {
    for (const e of errors) {
      console.log(`[discover]   错误: ${e.provider} — ${e.error}`)
    }
  }

  return { results, errors }
}
