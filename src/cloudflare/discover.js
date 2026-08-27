/**
 * 模型发现模块 — 遍历启用的 provider，通过 AI Gateway 获取 /v1/models 列表
 * @module ai-gateway-desk/src/cloudflare/discover
 */

const FETCH_TIMEOUT = 15_000 // 15 秒超时

// SSE debug 事件的响应体预览长度上限；完整响应体只输出到服务器终端日志，
// 避免大 JSON（OpenRouter 全量模型可达数 MB）塞爆前端 200 行日志栏
const DEBUG_BODY_PREVIEW_LIMIT = 1000

/**
 * token 脱敏：保留首尾 4 字符，中间以 * 填充（与 setup.js maskToken 同策略）
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
 *   - config.debug === true 时额外触发 { status: 'debug', debug: {...} }：
 *       phase 'request' → { method, url, headers }（authorization 头已脱敏）
 *       phase 'response' → { httpStatus, statusText, headers, bytes, elapsedMs,
 *                            bodyPreview, truncated }（响应体截断预览，全文见服务器终端）
 *   done/total 为已完成数 / 总数（按完成顺序递增；debug 事件不计数）
 *
 * @param {object} config - loadConfig() 返回的配置对象；config.debug === true 开启详细日志
 * @param {string} gatewayToken - Cloudflare AI Gateway token
 * @param {(p: { provider: string, status: 'pending'|'done'|'error'|'debug', models?: number, error?: string, debug?: object, done: number, total: number }) => void} [onProgress] - 可选进度回调
 * @returns {Promise<{ results: Array<{ provider: string, models: Array<object> }>, errors: Array<{ provider: string, error: string }> }>}
 */
export async function discoverModels(config, gatewayToken, onProgress) {
  const { gateway, providers } = config
  const debug = config?.debug === true
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
    const modelPath = provider.pathPrefix ? `${provider.pathPrefix}/models` : `/v1/models`
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

    try {
      console.log(`[discover] 请求 [${slug}] ${method} ${url}`)
      if (debug) {
        const masked = maskHeaders(headers)
        console.log(`[discover][debug] 请求头 [${slug}]: ${JSON.stringify(masked)}`)
        emitDebug({ phase: 'request', method, url, headers: masked })
      }

      const response = await fetchWithTimeout(url, { method, headers })
      // 响应体只读一次（text），debug / 错误详情 / JSON 解析共用原文
      const text = await response.text()
      const respElapsed = Date.now() - providerStartTime

      if (debug) {
        const responseHeaders = Object.fromEntries(response.headers.entries())
        const bytes = Buffer.byteLength(text, 'utf8')
        console.log(`[discover][debug] 响应 [${slug}] HTTP ${response.status} ${response.statusText} (${bytes} 字节, ${respElapsed}ms)`)
        console.log(`[discover][debug]   响应头 [${slug}]: ${JSON.stringify(responseHeaders)}`)
        console.log(`[discover][debug]   响应体 [${slug}]:\n${text}`)
        emitDebug({
          phase: 'response',
          httpStatus: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          bytes,
          elapsedMs: respElapsed,
          truncated: text.length > DEBUG_BODY_PREVIEW_LIMIT,
          bodyPreview: text.slice(0, DEBUG_BODY_PREVIEW_LIMIT),
        })
      }

      if (!response.ok) {
        // 优先透出网关错误细节（如 400 Invalid provider），便于定位配置问题
        const errDetail = errorDetailFromText(response.status, response.statusText, text)
        console.log(`[discover] 失败 [${slug}] HTTP ${response.status}: ${errDetail}`)
        throw new Error(errDetail)
      }

      let body
      try {
        body = JSON.parse(text)
      } catch {
        const snippet = text.slice(0, 120).replace(/\s+/g, ' ')
        console.log(`[discover] 失败 [${slug}] 响应不是合法 JSON: ${snippet}`)
        throw new Error(`响应不是合法 JSON: ${snippet}`)
      }

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
