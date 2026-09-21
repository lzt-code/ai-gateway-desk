// ============================================================
// Provider 查找辅助 — gateway slug → providers.json 条目
// ============================================================
// model 中的 provider slug 使用 gatewaySlug 规则（custom-provider 带
// custom- 前缀，见 cloudflare/discover.js gatewaySlug），而 providers.json
// 的条目按原始 id 存储（如 id 'fang-zhou' → slug 'custom-fang-zhou'）。
// 本模块负责两者映射；读取 data/providers.json 时采用容错策略
// （对齐 cloudflare/providers-sync.js），文件缺失 / 损坏不致命。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gatewaySlug } from '../cloudflare/discover.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 data/ */
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

/**
 * 容错读取 providers 原始配置（不做严格校验）
 * @param {string} [dataDir]
 * @returns {{ gateway?: object, kv?: object, providers: Array<object> }}
 */
export function loadRawProvidersConfig(dataDir = DEFAULT_DATA_DIR) {
  try {
    const text = fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        gateway: parsed.gateway,
        kv: parsed.kv,
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      }
    }
  } catch {
    // 缺失 / 损坏：返回空配置
  }
  return { providers: [] }
}

/**
 * 在 providers 列表中按 gateway slug 查找条目。
 * @param {Array<object>} providers
 * @param {string} slug - gateway slug（如 custom-fang-zhou）
 * @returns {object|null}
 */
export function findProviderByGatewaySlug(providers, slug) {
  if (!Array.isArray(providers)) return null
  return providers.find((p) => p && gatewaySlug(p) === slug) || null
}

/**
 * 默认查找器：读本地 providers.json → 按 gateway slug 匹配。
 * @param {string} slug
 * @param {string} [dataDir]
 * @returns {object|null}
 */
export function findProvider(slug, dataDir = DEFAULT_DATA_DIR) {
  const { providers } = loadRawProvidersConfig(dataDir)
  return findProviderByGatewaySlug(providers, slug)
}
