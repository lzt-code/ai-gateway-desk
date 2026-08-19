/**
 * OpenRouter 富化模块 — 从 OpenRouter 获取模型信息，补全新模型的缺失字段
 * @module ai-gateway-desk/src/pipeline/enrich
 */

const FETCH_TIMEOUT = 15_000 // 15 秒超时
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/models'

/** @type {Array<object>|null} */
let cachedModels = null
/** @type {Promise<Array<object>>|null} */
let fetchPromise = null

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
 * 尝试从 OpenRouter 模型列表中匹配指定模型
 * @param {string} modelId - 带前缀的模型 id（如 "custom-agnes/agnes-2.0-flash"）
 * @param {Array<object>} orModels - OpenRouter 模型列表
 * @returns {object|null} 匹配到的 OpenRouter 模型对象，匹配不到返回 null
 */
function matchModel(modelId, orModels) {
  // 提取 modelId 中的短名称（去掉前缀）
  const shortId = modelId.includes('/')
    ? modelId.split('/').slice(1).join('/')
    : modelId

  // 优先级 a: OpenRouter 模型 id 完全等于 modelId
  const exact = orModels.find((m) => m.id === modelId)
  if (exact) return exact

  // 优先级 b: OpenRouter 模型 id 去掉前缀后等于 modelId 去掉前缀
  const shortMatch = orModels.find((m) => m.id === shortId)
  if (shortMatch) return shortMatch

  // 优先级 c: name 模糊匹配 modelId 的 name 部分
  const namePart = shortId.replace(/[-_]/g, ' ').toLowerCase()
  const nameMatch = orModels.find((m) => {
    if (!m.name) return false
    const orName = m.name.replace(/[-_]/g, ' ').toLowerCase()
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
 * 从 OpenRouter 模型列表中匹配该模型，只补全 existingMetadata 中不存在的字段
 * @param {string} modelId - 带前缀的模型 id
 * @param {object} existingMetadata - 已有元数据对象
 * @returns {Promise<object>} 合并后的 metadata 对象（不修改原对象）
 */
export async function enrichModel(modelId, existingMetadata) {
  let orModels
  try {
    orModels = await fetchOpenRouterModels()
  } catch {
    // fetch 失败，返回原 metadata
    return { ...existingMetadata }
  }

  if (!orModels || orModels.length === 0) {
    return { ...existingMetadata }
  }

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

  // name — 不覆盖
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
