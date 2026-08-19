import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { loadConfig } from '../core/config.js'
import { gatewaySlug } from '../cloudflare/discover.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MODELS_JSON_PATH = join(__dirname, '..', '..', 'data', 'models.json')

/**
 * 从 state 中过滤所有 status === "selected" 且不属于隐藏 provider 的条目，
 * 提取每个条目的 metadata（去掉 status 和 provider 字段）。
 *
 * 隐藏的 provider（config 中 enabled===false）下的模型不写入 models.json，
 * 因此 worker /models 也不会暴露它们；state 本身保留，重新显示即可恢复。
 *
 * @param {Object} state - model-states.json 的内容
 * @param {Object} [options]
 * @param {Set<string>} [options.hiddenSlugs] - 被隐藏 provider 的网关 slug 集合
 * @returns {Array} 模型 metadata 数组
 */
export function generateModelsJson(state, { hiddenSlugs } = {}) {
  const hidden = hiddenSlugs instanceof Set ? hiddenSlugs : new Set()
  const selected = Object.entries(state).filter(([, entry]) => {
    if (entry.status !== 'selected') return false
    if (hidden.size === 0) return true
    const slug = typeof entry.provider === 'string'
      ? entry.provider
      : (entry.metadata && entry.metadata.provider) || null
    return !slug || !hidden.has(slug)
  })

  return selected.map(([id, entry]) => {
    const { status, provider, ...rest } = entry.metadata || {}
    // 手动添加的模型 metadata 不含 id，用 state key 补上
    if (!rest.id) {
      rest.id = id
    }
    return rest
  })
}

/**
 * 生成并写入 data/models.json 文件（2 空格缩进）。
 * 隐藏的 provider（config 中 enabled===false）下的模型不写入，
 * 使 worker /models 不暴露它们；config 缺失/校验失败时不做隐藏过滤。
 * @param {Object} state - model-states.json 的内容
 */
export function writeModelsJson(state) {
  let hiddenSlugs
  try {
    const config = loadConfig()
    hiddenSlugs = new Set(
      (Array.isArray(config.providers) ? config.providers : [])
        .filter((p) => p && p.enabled === false)
        .map((p) => gatewaySlug(p))
    )
  } catch {
    hiddenSlugs = new Set()
  }
  const json = generateModelsJson(state, { hiddenSlugs })
  const dir = dirname(MODELS_JSON_PATH)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(MODELS_JSON_PATH, JSON.stringify(json, null, 2) + '\n', 'utf-8')
}
