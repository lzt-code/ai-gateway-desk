// ============================================================
// 厂商凭证本地加密存储 — 按 provider slug 存完整 headers 对象
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §8.1）：
//   local 模式需要在本机直连厂商，因此按 slug 保存该 provider 的完整
//   请求头（不止 Bearer，兼容自定义鉴权头），存储路径：
//     ~/.ai-gateway-desk/provider-keys/<slug>
//
// 加解密原语复用 src/core/token-store.js（Windows DPAPI /
// macOS Keychain / Linux 0600 文件），测试经 AI_GW_TEST_DIR 隔离。
// ============================================================

import { readSecret, writeSecret, deleteSecret } from '../core/token-store.js'

const PREFIX = 'provider-keys'

/**
 * 校验 slug 并返回存储名
 * @param {string} slug
 * @returns {string}
 */
function entryName(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error('无效的 provider slug')
  }
  return `${PREFIX}/${slug}`
}

/**
 * 写入 provider 的完整凭证 headers
 * @param {string} slug - provider 的 gateway slug（如 custom-ark）
 * @param {Record<string, string>} headers - 完整请求头对象
 * @throws headers 非对象 / 为空、或写入失败时抛错
 */
export function writeProviderHeaders(slug, headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers 必须是对象')
  }
  const keys = Object.keys(headers)
  if (!keys.length) throw new Error('headers 不能为空对象')
  for (const k of keys) {
    if (typeof headers[k] !== 'string') {
      throw new Error(`headers.${k} 必须是字符串`)
    }
  }
  writeSecret(entryName(slug), JSON.stringify(headers))
}

/**
 * 读取 provider 的完整凭证 headers
 * @param {string} slug
 * @returns {Record<string, string>|null} headers 对象；未保存 / 损坏返回 null
 */
export function readProviderHeaders(slug) {
  const raw = readSecret(entryName(slug))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return /** @type {Record<string, string>} */ (parsed)
  } catch {
    return null
  }
}

/**
 * 删除 provider 的本地凭证
 * @param {string} slug
 */
export function deleteProviderHeaders(slug) {
  deleteSecret(entryName(slug))
}

/**
 * 本地是否已保存该 provider 的凭证
 * @param {string} slug
 * @returns {boolean}
 */
export function hasProviderKey(slug) {
  return readProviderHeaders(slug) !== null
}
