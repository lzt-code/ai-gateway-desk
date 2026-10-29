/**
 * 模型富化模块 — 双源融合补全新模型的缺失字段
 *
 * 数据源（按优先级）：
 *   1. OpenRouter（https://openrouter.ai/api/v1/models）—— 现有源，字段较全
 *   2. models.dev（https://models.dev/catalog.json）—— 开源模型数据库，
 *      覆盖 195+ provider、字段更规整（limit.context/output、modalities 数组、
 *      tool_call/reasoning/structured_output 布尔能力），OpenRouter 匹配不到或
 *      补全后仍缺失的字段由 models.dev 兜底
 *
 * 语义：只补全 existingMetadata 中不存在的字段（两个例外：name 由 OR 覆盖以修正
 *       历史误匹配；pricing 覆盖已有值以跟随上游改价——provider 自报价格的还原
 *       由 sync-flow 在 enrich 之后统一处理，provider 价格优先于富化源）
 *
 * 容错：两源并发拉取，任一源失败静默跳过（只补另一源的字段）；失败源在
 *       FAILURE_RETRY_MS 窗口内负缓存，避免 enrich 循环逐模型重发请求——
 *       旧行为「失败即清空 promise」会让每个模型各等一次超时，同步整段卡住。
 *
 * @module ai-gateway-desk/src/pipeline/enrich
 */

import { logRequest, logResponse, logResult } from '../core/io-logger.js'

const FETCH_TIMEOUT = 15_000 // OpenRouter 列表：15 秒超时
const CATALOG_TIMEOUT = 30_000 // models.dev catalog 体积达数 MB，读正文需要更宽裕的时间
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models'
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json'
// 失败负缓存窗口：某源本进程内失败后，窗口期内直接按「不可用」返回，不再重发请求。
// 否则 enrich 循环里每个模型都会重新 fetch 一次并再等满一个超时（model 数量 × 超时），
// 表现就是「一个源失败后整个同步卡住」。
const FAILURE_RETRY_MS = 5 * 60_000

/** @type {Array<object>|null} */
let cachedModels = null
/** @type {Promise<Array<object>>|null} */
let fetchPromise = null
/** @type {number} OpenRouter 上次失败时间（0 = 无失败记录） */
let modelsFailedAt = 0
/** @type {object|null} */
let cachedCatalog = null
/** @type {Promise<object>|null} */
let catalogPromise = null
/** @type {number} models.dev 上次失败时间（0 = 无失败记录） */
let catalogFailedAt = 0

/**
 * 取短 id（去掉第一段网关前缀）。
 * 单层如 "custom-glm/glm-5" → "glm-5"；
 * 双层如 "custom-vercel/spacexai/grok-4.6"（上游 id 本身含 slash）→ "spacexai/grok-4.6"
 */
function shortIdOf(modelId) {
  return modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId
}

/**
 * 取末段 id（去掉所有前缀）。
 * "custom-vercel/spacexai/grok-4.6" → "grok-4.6"，用于兼容上游 id 自带 slash 的双前缀场景
 */
function baseIdOf(modelId) {
  return modelId.includes('/') ? modelId.split('/').pop() : modelId
}

/**
 * 归一化名称用于模糊匹配：分隔符（- _ / :）统一视为空格后小写比较
 */
function normName(s) {
  return String(s || '').replace(/[-_/:]+/g, ' ').toLowerCase()
}

/**
 * 带超时的 JSON GET，统一走 IO 日志器。
 *
 * 超时覆盖「连接 + 读响应体」全过程：只覆盖响应头时，卡在正文传输的连接会无限
 * 等待（catalog.json 数 MB，弱网下常出现），同步流程会看起来卡死。
 *
 * @param {string} url
 * @param {object} options
 * @param {string} options.operation - 日志操作名（域:动作[:目标]）
 * @param {string} options.label - 错误文案中的源名称
 * @param {number} [options.timeoutMs=FETCH_TIMEOUT]
 * @param {(body: any) => void} [options.validate] - 解析后的结构校验，抛错即视为失败
 * @returns {Promise<any>} 解析后的 JSON
 */
async function fetchJsonWithTimeout(url, { operation, label, timeoutMs = FETCH_TIMEOUT, validate } = {}) {
  const start = Date.now()
  const headers = { Accept: 'application/json' }
  logRequest(operation, { method: 'GET', url, headers })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let status = null
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
    status = res.status
    if (!res.ok) {
      throw new Error(`${label} 返回 ${res.status} ${res.statusText}`)
    }
    const text = await res.text()
    const bytes = Buffer.byteLength(text, 'utf8')
    const body = JSON.parse(text)
    if (validate) validate(body)
    const elapsed = Date.now() - start
    logResponse(operation, { status: res.status, statusText: res.statusText, bytes, elapsedMs: elapsed })
    logResult(operation, { ok: true, message: `收到 ${bytes} 字节`, elapsedMs: elapsed })
    return body
  } catch (err) {
    const elapsed = Date.now() - start
    const timedOut = controller.signal.aborted
    const message = timedOut
      ? `请求超时 (${timeoutMs / 1000}s): ${url}`
      : err instanceof Error ? err.message : String(err)
    logResponse(operation, { status, output: message, elapsedMs: elapsed })
    logResult(operation, { ok: false, message, elapsedMs: elapsed })
    throw timedOut ? new Error(message) : err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 OpenRouter 获取模型列表
 * 缓存在模块级变量中，多次调用只 fetch 一次；失败时返回空数组，
 * 并在 FAILURE_RETRY_MS 窗口内不再重试（负缓存），避免逐模型重复等超时。
 * @returns {Promise<Array<object>>} 模型数组
 */
export async function fetchOpenRouterModels() {
  if (cachedModels) {
    return cachedModels
  }

  if (fetchPromise) {
    return fetchPromise
  }

  if (modelsFailedAt && Date.now() - modelsFailedAt < FAILURE_RETRY_MS) {
    return []
  }

  fetchPromise = (async () => {
    try {
      const body = await fetchJsonWithTimeout(OPENROUTER_API_URL, {
        operation: 'enrich:openrouter:models',
        label: 'OpenRouter API',
        validate: (b) => {
          // OpenRouter 返回 { data: [...] }
          if (!b || !Array.isArray(b.data)) {
            throw new Error('OpenRouter 返回格式异常: 缺少 data 数组')
          }
        },
      })

      cachedModels = body.data
      modelsFailedAt = 0
      return cachedModels
    } catch {
      // 失败记时并清空进行中的 promise（窗口过期后可重试）；失败详情已由日志器记录
      modelsFailedAt = Date.now()
      fetchPromise = null
      return []
    }
  })()

  return fetchPromise
}

/**
 * 从 models.dev 获取 catalog（providers + models 元数据）
 * 缓存在模块级变量中，多次调用只 fetch 一次；失败时返回 null，
 * 并在 FAILURE_RETRY_MS 窗口内不再重试（负缓存）。
 * @returns {Promise<object|null>} catalog 对象（{ providers, models }），失败返回 null
 */
export async function fetchModelsDevCatalog() {
  if (cachedCatalog) {
    return cachedCatalog
  }

  if (catalogPromise) {
    return catalogPromise
  }

  if (catalogFailedAt && Date.now() - catalogFailedAt < FAILURE_RETRY_MS) {
    return null
  }

  catalogPromise = (async () => {
    try {
      const body = await fetchJsonWithTimeout(MODELS_DEV_CATALOG_URL, {
        operation: 'enrich:modelsdev:catalog',
        label: 'models.dev API',
        timeoutMs: CATALOG_TIMEOUT,
        validate: (b) => {
          // catalog.json 结构：{ providers: { [id]: Provider }, models: { [lab/model]: ModelMetadata } }
          if (!b || typeof b !== 'object') {
            throw new Error('models.dev 返回格式异常: 期望对象')
          }
        },
      })

      cachedCatalog = body
      catalogFailedAt = 0
      return cachedCatalog
    } catch {
      // 失败记时并清空进行中的 promise（窗口过期后可重试）；失败详情已由日志器记录
      catalogFailedAt = Date.now()
      catalogPromise = null
      return null
    }
  })()

  return catalogPromise
}

/**
 * 尝试从 OpenRouter 模型列表中匹配指定模型
 * @param {string} modelId - 带前缀的模型 id（如 "custom-agnes/agnes-2.0-flash"）
 * @param {Array<object>} orModels - OpenRouter 模型列表
 * @returns {object|null} 匹配到的 OpenRouter 模型对象，匹配不到返回 null
 */
function matchModel(modelId, orModels) {
  // 提取 modelId 中的短名称（去掉前缀）
  const shortId = shortIdOf(modelId)
  const baseId = baseIdOf(modelId)

  // 优先级 a: OpenRouter 模型 id 完全等于 modelId
  const exact = orModels.find((m) => m.id === modelId)
  if (exact) return exact

  // 优先级 b: OpenRouter 模型 id 去掉前缀后等于 modelId 去掉前缀
  const shortMatch = orModels.find((m) => m.id === shortId)
  if (shortMatch) return shortMatch

  // 优先级 b1: OpenRouter 模型 id 去掉其 provider 前缀后等于 shortId
  // 例：modelId="custom-glm/glm-5" → shortId="glm-5"
  //     OpenRouter id="z-ai/glm-5" → 去前缀="glm-5" → 精确匹配
  // 避免落入优先级 c 模糊匹配时 "glm 5" 成为 "glm 5.3 flash" 子串而误匹配
  const prefixlessMatch = orModels.find((m) => {
    if (!m.id || !m.id.includes('/')) return false
    const mShort = m.id.split('/').slice(1).join('/')
    return mShort === shortId
  })
  if (prefixlessMatch) return prefixlessMatch

  // 优先级 b2: 末段精确匹配（兼容上游 id 自带 slash 的双前缀场景）
  // 例：modelId="custom-vercel/spacexai/grok-4.6" → baseId="grok-4.6"
  //     OpenRouter id="x-ai/grok-4.6" → 去前缀="grok-4.6" → 精确匹配
  // 仍是精确比较，不会引入 c 的子串误匹配风险
  if (baseId && baseId !== shortId) {
    const baseMatch = orModels.find((m) => {
      if (!m.id || !m.id.includes('/')) return m.id === baseId
      const mShort = m.id.split('/').slice(1).join('/')
      const mBase = m.id.split('/').pop()
      return mShort === baseId || mBase === baseId
    })
    if (baseMatch) return baseMatch
  }

  // 优先级 c: name 模糊匹配 modelId 的 name 部分（用末段，避免网关前缀干扰）
  const namePart = normName(baseId)
  const nameMatch = orModels.find((m) => {
    if (!m.name) return false
    const orName = normName(m.name)
    return orName.includes(namePart) || namePart.includes(orName)
  })
  if (nameMatch) return nameMatch

  return null
}

/**
 * 解析 OpenRouter 的 modality 格式（如 "text->text"）到 input/output_modalities 数组
 * @param {string} modality
 * @returns {{ input_modalities?: string[], output_modalities?: string[] }|null}
 */
function parseModality(modality) {
  if (!modality || typeof modality !== 'string') return null

  const parts = modality.split('->')
  if (parts.length !== 2) return null

  const input = parts[0].trim()
  const output = parts[1].trim()

  const result = {}
  if (input && input !== 'undefined') {
    result.input_modalities = input
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (output && output !== 'undefined') {
    result.output_modalities = output
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return result
}

/**
 * 归一化 OpenRouter pricing 对象 → { prompt, completion }（USD / token，数字）。
 * OR 价格为字符串（如 "0.0000015"；"-1" 表示变量计价等无效值，跳过该字段）；
 * 全部无效返回 null。
 * @param {object} p - OpenRouter 模型的 pricing 字段
 * @returns {{ prompt?: number, completion?: number }|null}
 */
function normalizeOpenRouterPricing(p) {
  if (!p || typeof p !== 'object') return null
  const out = {}
  const prompt = Number(p.prompt)
  const completion = Number(p.completion)
  if (Number.isFinite(prompt) && prompt >= 0) out.prompt = prompt
  if (Number.isFinite(completion) && completion >= 0) out.completion = completion
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 归一化 models.dev cost 对象 → { prompt, completion }（USD / token，数字）。
 * cost.input → prompt、cost.output → completion；全部无效返回 null。
 * @param {object} cost - models.dev 模型的 cost 字段
 * @returns {{ prompt?: number, completion?: number }|null}
 */
function normalizeModelsDevCost(cost) {
  if (!cost || typeof cost !== 'object') return null
  const out = {}
  if (Number.isFinite(cost.input) && cost.input >= 0) out.prompt = cost.input
  if (Number.isFinite(cost.output) && cost.output >= 0) out.completion = cost.output
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 从 OpenRouter 模型列表中匹配并补全字段（只补 existingMetadata 中不存在的；
 * pricing 例外：覆盖已有值以跟随上游改价）
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象
 * @param {Array<object>} orModels - OpenRouter 模型列表
 * @returns {{ metadata: object, providedPricing: boolean }}
 *   metadata：合并后的 metadata 对象（匹配不到时返回 existingMetadata 的拷贝）；
 *   providedPricing：本轮是否写入了 pricing（供 MD 源做优先级让位判断）
 */
function enrichFromOpenRouter(modelId, existingMetadata, orModels) {
  const matched = matchModel(modelId, orModels)
  if (!matched) {
    return { metadata: { ...existingMetadata }, providedPricing: false }
  }

  // 只补全 existingMetadata 中不存在的字段，已有的不覆盖
  const result = { ...existingMetadata }

  // id — 不覆盖（已有前缀）
  if (result.id === undefined && matched.id) {
    result.id = matched.id
  }

  // name — 只补全缺失字段，不覆盖已有值（与其他字段一致）
  if (result.name === undefined && matched.name) {
    result.name = matched.name
  }

  // context_length — 不覆盖
  if (result.context_length === undefined && matched.context_length != null) {
    result.context_length = matched.context_length
  }

  // max_output_length — 优先从 API 响应取，其次从 top_provider.context_length 映射，不覆盖
  if (result.max_output_length === undefined) {
    if (matched.max_output_length != null) {
      result.max_output_length = matched.max_output_length
    } else if (matched.top_provider?.context_length != null) {
      result.max_output_length = matched.top_provider.context_length
    }
  }

  // input_modalities / output_modalities
  // 优先用 architecture 中的数组字段，如果不存在则解析 modality 字符串
  if (result.input_modalities === undefined || result.output_modalities === undefined) {
    const archInput = matched.architecture?.input_modalities
    const archOutput = matched.architecture?.output_modalities

    if (result.input_modalities === undefined) {
      if (Array.isArray(archInput) && archInput.length > 0) {
        result.input_modalities = [...archInput]
      }
    }
    if (result.output_modalities === undefined) {
      if (Array.isArray(archOutput) && archOutput.length > 0) {
        result.output_modalities = [...archOutput]
      }
    }

    // 如果数组字段不存在，尝试解析 modality 字符串
    if (
      (result.input_modalities === undefined || result.output_modalities === undefined) &&
      matched.architecture?.modality
    ) {
      const parsed = parseModality(matched.architecture.modality)
      if (parsed) {
        if (result.input_modalities === undefined && parsed.input_modalities) {
          result.input_modalities = parsed.input_modalities
        }
        if (result.output_modalities === undefined && parsed.output_modalities) {
          result.output_modalities = parsed.output_modalities
        }
      }
    }
  }

  // supported_sampling_parameters — 从 supported_parameters 映射，不覆盖
  if (
    result.supported_sampling_parameters === undefined &&
    Array.isArray(matched.supported_parameters)
  ) {
    result.supported_sampling_parameters = [...matched.supported_parameters]
  }

  // supported_features — 从 supported_parameters 推断，不覆盖
  if (result.supported_features === undefined && Array.isArray(matched.supported_parameters)) {
    const features = []
    if (matched.supported_parameters.includes('tools')) {
      features.push('tools')
    }
    if (
      matched.supported_parameters.some(
        (p) => p.includes('json') || p.includes('response_format')
      )
    ) {
      features.push('json_mode')
    }
    if (features.length > 0) {
      result.supported_features = features
    }
  }

  // pricing — 覆盖已有值（例外于 fill-only）：上游改价需跟随更新，否则历史
  // 价格永远停留。provider 自报价格的还原由 sync-flow 在 enrich 之后统一处理。
  let providedPricing = false
  const freshPricing = normalizeOpenRouterPricing(matched.pricing)
  if (freshPricing) {
    result.pricing = freshPricing
    providedPricing = true
  }

  return { metadata: result, providedPricing }
}

/**
 * 在 catalog.providers 中查找指定 canonical model id 的 provider model（取第一个匹配）
 * provider model 含 limit.output（必填），用于补全 max_output_length
 * @param {object} catalog - models.dev catalog
 * @param {string} canonicalId - catalog.models 的 key（如 "zhipuai/glm-5.2"）
 * @returns {object|null} provider model 对象，找不到返回 null
 */
function findProviderModel(catalog, canonicalId) {
  const providers = catalog.providers
  if (!providers || typeof providers !== 'object') return null

  // canonicalId 格式 "lab/model"，优先在同名 provider 下找
  const slashIdx = canonicalId.indexOf('/')
  if (slashIdx > 0) {
    const lab = canonicalId.slice(0, slashIdx)
    const modelKey = canonicalId.slice(slashIdx + 1)
    const p = providers[lab]
    if (p?.models?.[modelKey]) return p.models[modelKey]
    // 同名 provider 找不到，遍历所有 provider 按 key/id 匹配
  }

  const shortId = slashIdx > 0 ? canonicalId.slice(slashIdx + 1) : canonicalId
  for (const p of Object.values(providers)) {
    const models = p?.models
    if (!models) continue
    // key 直接等于 shortId
    if (models[shortId]) return models[shortId]
    // 或 model.id === shortId
    for (const m of Object.values(models)) {
      if (m.id === shortId) return m
    }
  }
  return null
}

/**
 * 尝试从 models.dev catalog 中匹配指定模型
 * @param {string} modelId - 带前缀的模型 id（如 "custom-glm/glm-5"）
 * @param {object} catalog - models.dev catalog（{ providers, models }）
 * @returns {{ metadata: object|null, providerModel: object|null }|null}
 *   匹配结果；metadata 为 catalog.models 的条目，providerModel 为 catalog.providers 下的具体条目
 */
function matchModelsDev(modelId, catalog) {
  const modelsMap = catalog.models
  if (!modelsMap || typeof modelsMap !== 'object') return null

  // 提取 modelId 中的短名称（去掉 provider 前缀）
  const shortId = shortIdOf(modelId)
  const baseId = baseIdOf(modelId)

  // 优先级 a: catalog.models key 完全等于 modelId
  if (modelsMap[modelId]) {
    return { metadata: modelsMap[modelId], providerModel: findProviderModel(catalog, modelId) }
  }

  // 优先级 b: catalog.models key 去掉 lab 前缀后等于 shortId
  //   modelId="custom-glm/glm-5" → shortId="glm-5"
  //   catalog key="zhipuai/glm-5" → 去前缀="glm-5" → 匹配
  for (const [id, m] of Object.entries(modelsMap)) {
    const mShort = id.includes('/') ? id.split('/').slice(1).join('/') : id
    if (mShort === shortId) {
      return { metadata: m, providerModel: findProviderModel(catalog, id) }
    }
  }

  // 优先级 b2: 末段精确匹配（兼容双前缀，如 custom-vercel/spacexai/grok-4.6 → grok-4.6 ↔ xai/grok-4.6）
  if (baseId && baseId !== shortId) {
    for (const [id, m] of Object.entries(modelsMap)) {
      const mShort = id.includes('/') ? id.split('/').slice(1).join('/') : id
      const mBase = id.includes('/') ? id.split('/').pop() : id
      if (mShort === baseId || mBase === baseId) {
        return { metadata: m, providerModel: findProviderModel(catalog, id) }
      }
    }
  }

  // 优先级 c: provider model 的 id（provider-scoped）等于 shortId
  //   catalog.models 没匹配到时，在 catalog.providers 里按 provider-scoped id 找
  const providers = catalog.providers
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers)) {
      const models = p?.models
      if (!models) continue
      if (models[shortId]) {
        const pm = models[shortId]
        return { metadata: findMetadataByProviderModel(modelsMap, pm), providerModel: pm }
      }
    }
    // c2: 末段匹配（双前缀兜底）
    if (baseId && baseId !== shortId) {
      for (const p of Object.values(providers)) {
        const models = p?.models
        if (!models) continue
        if (models[baseId]) {
          const pm = models[baseId]
          return { metadata: findMetadataByProviderModel(modelsMap, pm), providerModel: pm }
        }
      }
    }
  }

  // 优先级 d: name 模糊匹配 modelId 的短名（用末段，避免网关前缀干扰）
  const namePart = normName(baseId)
  for (const [id, m] of Object.entries(modelsMap)) {
    if (!m.name) continue
    const mdName = normName(m.name)
    if (mdName.includes(namePart) || namePart.includes(mdName)) {
      return { metadata: m, providerModel: findProviderModel(catalog, id) }
    }
  }

  return null
}

/**
 * 通过 provider model 反查 catalog.models 中的 metadata（按 name 匹配）
 * @param {object} modelsMap - catalog.models
 * @param {object} pm - provider model
 * @returns {object|null}
 */
function findMetadataByProviderModel(modelsMap, pm) {
  if (!pm?.name) return null
  for (const m of Object.values(modelsMap)) {
    if (m.name === pm.name) return m
  }
  return null
}

/**
 * 从 models.dev catalog 中匹配该模型，只补全 existingMetadata 中不存在的字段
 * 优先级低于 OpenRouter：OR 未覆盖的字段由 models.dev 兜底
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象（可能已被 OR 补全过）
 * @param {object} catalog - models.dev catalog
 * @param {object} [options]
 * @param {boolean} [options.skipPricing=false] - OR 本轮已写入 pricing 时为 true，
 *   跳过 cost 映射（OR 优先级高于 MD，不让 MD 覆盖 OR 的新鲜价格）
 * @returns {object|null} 合并后的 metadata 对象；匹配不到返回 null
 */
function enrichFromModelsDev(modelId, existingMetadata, catalog, { skipPricing = false } = {}) {
  const matched = matchModelsDev(modelId, catalog)
  if (!matched) return null

  const { metadata, providerModel } = matched
  // provider model 字段更全（limit.output 必填、modalities 必填），优先用
  const source = providerModel || metadata
  if (!source) return null

  const result = { ...existingMetadata }

  // name — MD 优先级低于 OR：只在 result.name 未设置时补（OR 已覆盖则保留）
  //   metadata.name 是官方名（如 "Claude Opus 5"），比 provider 的更权威
  if (result.name === undefined) {
    const mdName = metadata?.name || providerModel?.name
    if (mdName) result.name = mdName
  }

  // limit — provider model 优先（output 必填），回退 metadata
  const limit = providerModel?.limit || metadata?.limit
  if (result.context_length === undefined && limit?.context != null) {
    result.context_length = limit.context
  }
  if (result.max_output_length === undefined && limit?.output != null) {
    result.max_output_length = limit.output
  }

  // modalities — provider model 必有，metadata 可选；数组形式（text/audio/image/video/pdf）
  const modalities = providerModel?.modalities || metadata?.modalities
  if (modalities) {
    if (result.input_modalities === undefined && Array.isArray(modalities.input)) {
      result.input_modalities = [...modalities.input]
    }
    if (result.output_modalities === undefined && Array.isArray(modalities.output)) {
      result.output_modalities = [...modalities.output]
    }
  }

  // cost — 与 OR 的 pricing 同语义：覆盖已有值以跟随上游改价（归一化为
  // { prompt, completion }，cost.input → prompt、cost.output → completion）；
  // OR 本轮已提供 pricing 时跳过（skipPricing），保持 OR > MD 的源优先级
  if (!skipPricing) {
    const freshCost = normalizeModelsDevCost(providerModel?.cost ?? metadata?.cost)
    if (freshCost) {
      result.pricing = freshCost
    }
  }

  // supported_sampling_parameters — 从布尔能力推断，不覆盖
  if (result.supported_sampling_parameters === undefined) {
    const params = []
    if (source.tool_call === true) params.push('tools')
    if (source.structured_output === true) params.push('response_format', 'json_schema')
    if (source.temperature === true) params.push('temperature', 'top_p')
    if (params.length > 0) {
      result.supported_sampling_parameters = params
    }
  }

  // supported_features — 从布尔能力推断，不覆盖
  if (result.supported_features === undefined) {
    const features = []
    if (source.reasoning === true) features.push('reasoning')
    if (source.tool_call === true) features.push('tools')
    if (source.structured_output === true) features.push('json_mode')
    if (features.length > 0) {
      result.supported_features = features
    }
  }

  return result
}

/**
 * 归一化上游别名字段到正名字段（只补缺失，不覆盖已有值，不修改原对象）：
 *   - context_window（部分网关 /v1/models 直接返回）→ context_length（UI/表格唯一读取的字段）
 *   - modalities: { input, output }（同上）→ input_modalities / output_modalities
 *   - supported_parameters（上游数组）→ supported_sampling_parameters
 *   - max_tokens（上游）→ max_output_length（best-effort；外部源的同名字段量级一致）
 * 背景：custom-vercel 等 provider 的 /v1/models 自带丰富字段，但用的是别名，
 * UI 只读正名，导致“有数据却显示缺失”。
 * @param {object} metadata
 * @returns {object} 归一化后的新对象
 */
export function normalizeMetadataAliases(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata
  const result = { ...metadata }
  if (result.context_length === undefined && result.context_window != null) {
    result.context_length = result.context_window
  }
  if (result.max_output_length === undefined && result.max_tokens != null) {
    result.max_output_length = result.max_tokens
  }
  const mods = result.modalities
  if (result.input_modalities === undefined && Array.isArray(mods?.input)) {
    result.input_modalities = [...mods.input]
  }
  if (result.output_modalities === undefined && Array.isArray(mods?.output)) {
    result.output_modalities = [...mods.output]
  }
  if (
    result.supported_sampling_parameters === undefined &&
    Array.isArray(result.supported_parameters)
  ) {
    result.supported_sampling_parameters = [...result.supported_parameters]
  }
  return result
}

/**
 * 双源富化：OpenRouter 优先 → models.dev 兜底
 * 只补全 existingMetadata 中不存在的字段；name 由 OR 覆盖（修正历史误匹配），
 * pricing 由 OR/MD 覆盖（跟随上游改价，OR 优先），OR 未覆盖时由 MD 补。
 * 任一源 fetch 失败静默跳过，不中断流程。
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象
 * @returns {Promise<object>} 合并后的 metadata 对象（不修改原对象）
 */
export async function enrichModel(modelId, existingMetadata) {
  // 先归一化上游别名：网关自带字段（如 context_window）直接转正名，
  // 即使外部源匹配失败也能显示
  let result = normalizeMetadataAliases({ ...existingMetadata })

  // 两个源并发拉取（各自带超时 + 失败负缓存）：任一源失败不阻塞另一源，
  // 首轮最坏耗时从「两段超时相加」降为「单段超时」
  const [orModels, catalog] = await Promise.all([
    fetchOpenRouterModels().catch(() => []),
    fetchModelsDevCatalog().catch(() => null),
  ])

  // 源 1: OpenRouter（现有逻辑，name 无条件覆盖以修正历史误匹配；
  //        pricing 覆盖以跟随上游改价）
  let orPriced = false
  if (orModels && orModels.length > 0) {
    try {
      const or = enrichFromOpenRouter(modelId, result, orModels)
      result = or.metadata
      orPriced = or.providedPricing
    } catch {
      // OR 匹配/合并异常，继续尝试 MD
    }
  }

  // 源 2: models.dev（补 OR 未覆盖的字段；OR 没匹配到时全量补；
  //        OR 已提供 pricing 时跳过 cost，保持源优先级）
  if (catalog) {
    try {
      const mdResult = enrichFromModelsDev(modelId, result, catalog, { skipPricing: orPriced })
      if (mdResult) {
        result = mdResult
      }
    } catch {
      // MD 合并异常，静默
    }
  }

  return result
}

/**
 * 重置模块级缓存（仅供测试使用）
 * 清空 OpenRouter 模型列表与 models.dev catalog 的缓存、进行中的 promise 及失败记录
 */
export function _resetCache() {
  cachedModels = null
  fetchPromise = null
  modelsFailedAt = 0
  cachedCatalog = null
  catalogPromise = null
  catalogFailedAt = 0
}
