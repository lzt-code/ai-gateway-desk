/**
 * Cloudflare KV REST API 封装（管理 Token）
 * @module ai-gateway-desk/src/cloudflare/kv
 *
 * 用途：在管理端直接读写 KV 单个键（无需 spawn wrangler），用于跨 PC 同步
 * provider 可见性（provider-visibility 键）等小型配置。
 *
 * 凭证：apiToken 为账户级管理 Token（需 KV 读写权限，创建 namespace 的同一 Token 即满足）。
 * 大块数据（models.json）仍走 wrangler kv:key put --path（见 output/deploy.js）。
 */

import { logRequest, logResponse, logResult } from '../core/io-logger.js'

const API_BASE = 'https://api.cloudflare.com/client/v4'
const FETCH_TIMEOUT = 30_000

function guard(value, name) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new TypeError(`缺少必填参数: ${name}`)
  }
}

function kvPath(accountId, namespaceId, key) {
  return `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/`
    + `${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`
}

/**
 * 读取 KV 键的原始文本值。
 * 键不存在（404）返回 null（不抛错），其余非 2xx 抛 Error。
 * @param {string} apiToken
 * @param {string} accountId
 * @param {string} namespaceId
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function readKvValue(apiToken, accountId, namespaceId, key) {
  guard(apiToken, 'apiToken')
  guard(accountId, 'accountId')
  guard(namespaceId, 'namespaceId')
  guard(key, 'key')

  const op = `kv:GET ${key}`
  const path = kvPath(accountId, namespaceId, key)
  const headers = { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' }
  const start = Date.now()
  logRequest(op, { method: 'GET', path, headers, meta: { namespaceId } })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    const text = res.status === 404 ? null : await res.text()
    const elapsed = Date.now() - start
    if (res.status === 404) {
      logResponse(op, { status: 404, statusText: 'Not Found', body: '', bytes: 0, elapsedMs: elapsed })
      logResult(op, { ok: true, message: '不存在(404)', elapsedMs: elapsed })
      return null
    }
    const bytes = text ? Buffer.byteLength(text, 'utf8') : 0
    logResponse(op, { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: text || '', bytes, elapsedMs: elapsed, truncated: (text || '').length > 2000 })
    if (!res.ok) {
      logResult(op, { ok: false, message: `HTTP ${res.status}`, elapsedMs: elapsed })
      throw new Error(`KV 读取失败 HTTP ${res.status}`)
    }
    logResult(op, { ok: true, message: `读取 ${bytes} 字节`, elapsedMs: elapsed })
    return text
  } catch (err) {
    if (err.message && err.message.startsWith('KV 读取失败')) throw err
    const elapsed = Date.now() - start
    logResponse(op, { status: null, output: err.message, elapsedMs: elapsed })
    logResult(op, { ok: false, message: err.message, elapsedMs: elapsed })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 写入 KV 键（原始文本值）。
 * @param {string} apiToken
 * @param {string} accountId
 * @param {string} namespaceId
 * @param {string} key
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function writeKvValue(apiToken, accountId, namespaceId, key, value) {
  guard(apiToken, 'apiToken')
  guard(accountId, 'accountId')
  guard(namespaceId, 'namespaceId')
  guard(key, 'key')

  const op = `kv:PUT ${key}`
  const path = kvPath(accountId, namespaceId, key)
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain' }
  const start = Date.now()
  const bodyPreview = typeof value === 'string' ? value : JSON.stringify(value)
  logRequest(op, { method: 'PUT', path, headers, body: bodyPreview.slice(0, 1000), meta: { namespaceId, bytes: Buffer.byteLength(bodyPreview, 'utf8') } })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'PUT',
      headers,
      body: value,
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    const elapsed = Date.now() - start
    logResponse(op, { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: text, bytes: Buffer.byteLength(text, 'utf8'), elapsedMs: elapsed })
    if (!res.ok) {
      logResult(op, { ok: false, message: `HTTP ${res.status}`, elapsedMs: elapsed })
      throw new Error(`KV 写入失败 HTTP ${res.status}`)
    }
    logResult(op, { ok: true, message: `写入 ${Buffer.byteLength(value, 'utf8')} 字节`, elapsedMs: elapsed })
  } catch (err) {
    if (err.message && err.message.startsWith('KV 写入失败')) throw err
    const elapsed = Date.now() - start
    logResponse(op, { status: null, output: err.message, elapsedMs: elapsed })
    logResult(op, { ok: false, message: err.message, elapsedMs: elapsed })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读取 KV 键并解析为 JSON。键不存在 / 内容非法时回退 fallback（不抛错）。
 * @param {string} apiToken
 * @param {string} accountId
 * @param {string} namespaceId
 * @param {string} key
 * @param {*} [fallback={}]
 * @returns {Promise<*>}
 */
export async function readKvJson(apiToken, accountId, namespaceId, key, fallback = {}) {
  const text = await readKvValue(apiToken, accountId, namespaceId, key)
  if (text === null) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 将 value JSON 序列化后写入 KV 键。
 * @param {string} apiToken
 * @param {string} accountId
 * @param {string} namespaceId
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export async function writeKvJson(apiToken, accountId, namespaceId, key, value) {
  await writeKvValue(apiToken, accountId, namespaceId, key, JSON.stringify(value))
}
