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
 * 语义：只补全 existingMetadata 中不存在的字段（name 例外，见 enrichFromOpenRouter）
 *
 * @module ai-gateway-desk/src/pipeline/enrich
 */

const FETCH_TIMEOUT = 15_000 // 15 秒超时
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models'
const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json'

/** @type {Array<object>|null} */
let cachedModels = null
/** @type {Promise<Array<object>>|null} */
let fetchPromise = null
/** @type {object|null} */
let cachedCatalog = null
/** @type {Promise<object>|null} */
let catalogPromise = null

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
 * 从 OpenRouter 获取模型列表
 * 缓存在模块级变量中，多次调用只 fetch 一次，失败时返回空数组
 * @returns {Promise<Array<object>>} 模型数组
 */
export async function fetchOpenRouterModels() {
  if (cachedModels) {
    return cachedModels
  }

  if (fetchPromise) {
    return fetchPromise
  }

  fetchPromise = (async () => {
    try {
      const response = await fetchWithTimeout(OPENROUTER_API_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(
          `OpenRouter API 返回 ${response.status} ${response.statusText}`
        )
      }

      const body = await response.json()

      // OpenRouter 返回 { data: [...] }
      if (!body || !Array.isArray(body.data)) {
        throw new Error('OpenRouter 返回格式异常: 缺少 data 数组')
      }

      cachedModels = body.data
      return cachedModels
    } catch (err) {
      // 失败时清空 promise，下次可重试
      fetchPromise = null
      console.warn(`[enrich] 获取 OpenRouter 模型列表失败: ${err.message}`)
      return []
    }
  })()

  return fetchPromise
}

/**
 * 从 models.dev 获取 catalog（providers + models 元数据）
 * 缓存在模块级变量中，多次调用只 fetch 一次，失败时返回 null
 * @returns {Promise<object|null>} catalog 对象（{ providers, models }），失败返回 null
 */
export async function fetchModelsDevCatalog() {
  if (cachedCatalog) {
    return cachedCatalog
  }

  if (catalogPromise) {
    return catalogPromise
  }

  catalogPromise = (async () => {
    try {
      const response = await fetchWithTimeout(MODELS_DEV_CATALOG_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`models.dev API 返回 ${response.status} ${response.statusText}`)
      }

      const body = await response.json()

      // catalog.json 结构：{ providers: { [id]: Provider }, models: { [lab/model]: ModelMetadata } }
      if (!body || typeof body !== 'object') {
        throw new Error('models.dev 返回格式异常: 期望对象')
      }

      cachedCatalog = body
      return cachedCatalog
    } catch (err) {
      // 失败时清空 promise，下次可重试
      catalogPromise = null
      console.warn(`[enrich] 获取 models.dev catalog 失败: ${err.message}`)
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
 * 从 OpenRouter 模型列表中匹配并补全字段（只补 existingMetadata 中不存在的）
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象
 * @param {Array<object>} orModels - OpenRouter 模型列表
 * @returns {object} 合并后的 metadata 对象（匹配不到时返回 existingMetadata 的拷贝）
 */
function enrichFromOpenRouter(modelId, existingMetadata, orModels) {
  const matched = matchModel(modelId, orModels)
  if (!matched) {
    return { ...existingMetadata }
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

  return result
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
 * @returns {object|null} 合并后的 metadata 对象；匹配不到返回 null
 */
function enrichFromModelsDev(modelId, existingMetadata, catalog) {
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
 * OR 未覆盖时由 MD 补。任一源 fetch 失败静默跳过，不中断流程。
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象
 * @returns {Promise<object>} 合并后的 metadata 对象（不修改原对象）
 */
export async function enrichModel(modelId, existingMetadata) {
  // 先归一化上游别名：网关自带字段（如 context_window）直接转正名，
  // 即使外部源匹配失败也能显示
  let result = normalizeMetadataAliases({ ...existingMetadata })

  // 源 1: OpenRouter（现有逻辑，name 无条件覆盖以修正历史误匹配）
  try {
    const orModels = await fetchOpenRouterModels()
    if (orModels && orModels.length > 0) {
      result = enrichFromOpenRouter(modelId, result, orModels)
    }
  } catch {
    // OR fetch 失败，继续尝试 MD
  }

  // 源 2: models.dev（补 OR 未覆盖的字段；OR 没匹配到时全量补）
  try {
    const catalog = await fetchModelsDevCatalog()
    if (catalog) {
      const mdResult = enrichFromModelsDev(modelId, result, catalog)
      if (mdResult) {
        result = mdResult
      }
    }
  } catch {
    // MD fetch 失败，静默
  }

  return result
}

/**
 * 重置模块级缓存（仅供测试使用）
 * 清空 OpenRouter 模型列表与 models.dev catalog 的缓存及进行中的 promise
 */
export function _resetCache() {
  cachedModels = null
  fetchPromise = null
  cachedCatalog = null
  catalogPromise = null
}
