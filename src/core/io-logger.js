/**
 * 统一 IO 日志工具（任务：补齐所有有 IO 操作的结果日志与调试细节）
 * @module ai-gateway-desk/src/core/io-logger
 *
 * 约定：
 * - 所有涉及内部/外部 IO 的操作（Cloudflare REST、KV REST、wrangler 子进程、文件读写）
 *   都通过本模块输出统一前缀日志。
 * - debug === true 时额外输出请求与响应细节（脱敏后），否则仅输出操作结果
 *   （成功/失败、耗时、关键摘要）。
 * - 为避免循环依赖，isDebugEnabled() 采用 try 读 data/providers.json（与 config.js
 *   同路径）并容错；调用方也可显式传入 debug boolean 以避免重复读盘。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PREVIEW_LIMIT = 1000

function resolveData(...segments) {
  return path.resolve(__dirname, '..', '..', 'data', ...segments)
}

export function isDebugEnabled() {
  try {
    const raw = readFileSync(resolveData('providers.json'), 'utf8')
    const cfg = JSON.parse(raw)
    return cfg && cfg.debug === true
  } catch {
    return false
  }
}

export function maskToken(token) {
  const s = String(token || '')
  if (s.length <= 8) return '*'.repeat(s.length || 4)
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`
}

export function maskHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
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

export function maskBody(body) {
  if (body == null) return body
  if (typeof body === 'string') {
    // 尝试 JSON 掩码 secret / token / apiKey 字段
    try {
      const obj = JSON.parse(body)
      return JSON.stringify(maskSecrets(obj))
    } catch {
      return body.slice(0, PREVIEW_LIMIT)
    }
  }
  if (typeof body === 'object') return maskSecrets(body)
  return body
}

function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const copy = Array.isArray(obj) ? [...obj] : { ...obj }
  for (const k of Object.keys(copy)) {
    if (/^(secret|token|apiKey|api_key|authorization)$/i.test(k) && typeof copy[k] === 'string') {
      copy[k] = maskToken(copy[k])
    } else if (copy[k] && typeof copy[k] === 'object') {
      copy[k] = maskSecrets(copy[k])
    }
  }
  return copy
}

function now() {
  return new Date().toISOString()
}

function fmtMs(ms) {
  return typeof ms === 'number' ? ` ${ms}ms` : ''
}

// ── UI 同步：内存环形缓冲 + 订阅（供 SSE 推送到前端“处理过程日志”）──
const MAX_BUFFER = 200
const _buffer = []
const _subscribers = new Set()

function pushEntry(entry) {
  _buffer.push(entry)
  if (_buffer.length > MAX_BUFFER) _buffer.shift()
  for (const fn of _subscribers) {
    try { fn(entry) } catch {}
  }
}

export function getRecentLogs(limit = MAX_BUFFER) {
  const n = Math.max(0, Math.min(limit, _buffer.length))
  return _buffer.slice(-n)
}

export function subscribeLogs(fn) {
  _subscribers.add(fn)
  return () => _subscribers.delete(fn)
}

export function clearLogs() {
  _buffer.length = 0
}

function toUiType(ok, isDebug = false) {
  if (isDebug) return 'info'
  return ok ? 'ok' : 'err'
}

export function logResult(operation, { ok, message, elapsedMs, extra } = {}) {
  const status = ok ? '成功' : '失败'
  const tail = [message, extra].filter(Boolean).join(' ')
  const text = `[io:${operation}] ${status}${fmtMs(elapsedMs)}${tail ? ` — ${tail}` : ''}`
  // eslint-disable-next-line no-console
  console.log(text)
  pushEntry({ ts: Date.now(), iso: now(), kind: 'result', op: operation, ok: !!ok, text, type: toUiType(!!ok) })
}

export function logRequest(operation, { method, url, path: reqPath, headers, body, namespaceId, key, command, args, meta } = {}, { debug } = {}) {
  const dbg = debug ?? isDebugEnabled()
  if (!dbg) return
  const h = headers ? ` headers=${JSON.stringify(maskHeaders(headers))}` : ''
  const b = body !== undefined ? ` body=${JSON.stringify(maskBody(body)).slice(0, PREVIEW_LIMIT)}` : ''
  const ns = namespaceId ? ` ns=${namespaceId} key=${key}` : ''
  const cmd = command ? ` cmd=${command} ${Array.isArray(args) ? args.join(' ') : ''}` : ''
  const m = meta ? ` ${JSON.stringify(meta).slice(0, 500)}` : ''
  const line = `${method || ''} ${url || reqPath || ''}${ns}${cmd}${h}${b}${m}`.trim()
  const text = `[io:${operation}][debug] → ${line}`
  // eslint-disable-next-line no-console
  console.log(text)
  pushEntry({ ts: Date.now(), iso: now(), kind: 'request', op: operation, ok: true, text, type: 'info' })
}

export function logResponse(operation, { status, statusText, headers, body, bytes, elapsedMs, output, truncated, meta } = {}, { debug } = {}) {
  const dbg = debug ?? isDebugEnabled()
  if (!dbg) return
  const st = status != null ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : ''
  const h = headers ? ` headers=${JSON.stringify(headers).slice(0, 800)}` : ''
  const b = body !== undefined ? ` body=${String(body).slice(0, PREVIEW_LIMIT)}${truncated ? ' …(截断)' : ''}` : ''
  const out = output !== undefined ? ` output=${String(output).slice(0, PREVIEW_LIMIT)}${String(output).length > PREVIEW_LIMIT ? ' …(截断)' : ''}` : ''
  const m = meta ? ` ${JSON.stringify(meta).slice(0, 500)}` : ''
  const line = [st, `bytes=${bytes ?? (body ? String(body).length : output ? String(output).length : '-')}`, `${elapsedMs ?? ''}ms`, h, b, out, m].filter(Boolean).join(' ')
  const text = `[io:${operation}][debug] ← ${line}`
  // eslint-disable-next-line no-console
  console.log(text)
  pushEntry({ ts: Date.now(), iso: now(), kind: 'response', op: operation, ok: status == null || (status >= 200 && status < 300), text, type: status == null || (status >= 200 && status < 300) ? 'info' : 'warn' })
}

export function buildIoDebugPayload({ method, url, path: reqPath, headers, body, status, statusText, respHeaders, respBody, bytes, elapsedMs, output, namespaceId, key, command, args, extra } = {}) {
  const payload = {}
  if (method || url || reqPath) payload.request = { method, url: url || reqPath, headers: headers ? maskHeaders(headers) : undefined, body: body !== undefined ? maskBody(body) : undefined, namespaceId, key, command, args }
  if (status != null || respBody !== undefined || output !== undefined) payload.response = { status, statusText, headers: respHeaders, body: respBody !== undefined ? String(respBody).slice(0, PREVIEW_LIMIT) : undefined, output: output !== undefined ? String(output).slice(0, PREVIEW_LIMIT) : undefined, bytes, elapsedMs, truncated: respBody != null && String(respBody).length > PREVIEW_LIMIT, extra }
  return payload
}
