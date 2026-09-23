/**
 * Worker 端统一 IO 日志工具（与主项目 src/core/io-logger.js 格式对齐）
 * @module ai-gateway-desk-worker/src/io-log
 *
 * 约定：
 * - Worker 内所有 IO（入站请求、KV 读取、转发 AI Gateway）都通过本模块输出。
 * - 默认仅输出操作结果（成功/失败、耗时、关键摘要）；debug 开启时额外输出
 *   请求与响应细节（脱敏后）。
 * - Worker 无文件系统，debug 开关取自 env.IO_DEBUG === 'true'，
 *   也可在运行时通过 setDebug() 切换。
 */

const PREVIEW_LIMIT = 1000

let debugEnabled = false

export function setDebug(value) {
  debugEnabled = value === true
}

export function isDebugEnabled() {
  return debugEnabled
}

export function maskToken(token) {
  const s = String(token || '')
  if (s.length <= 8) return '*'.repeat(s.length || 4)
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`
}

function maskSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const copy = Array.isArray(obj) ? [...obj] : { ...obj }
  for (const k of Object.keys(copy)) {
    if (/^(secret|token|apiKey|api_key|authorization|cf-aig-authorization)$/i.test(k) && typeof copy[k] === 'string') {
      copy[k] = maskToken(copy[k])
    } else if (copy[k] && typeof copy[k] === 'object') {
      copy[k] = maskSecrets(copy[k])
    }
  }
  return copy
}

export function maskHeaders(headers) {
  const out = {}
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Object.entries(headers || {})
  for (const [k, v] of entries) {
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
    try {
      return JSON.stringify(maskSecrets(JSON.parse(body)))
    } catch {
      return body.slice(0, PREVIEW_LIMIT)
    }
  }
  if (typeof body === 'object') return maskSecrets(body)
  return body
}

function fmtMs(ms) {
  return typeof ms === 'number' ? ` ${ms}ms` : ''
}

export function logResult(operation, { ok, message, elapsedMs, extra } = {}) {
  const status = ok ? '成功' : '失败'
  const tail = [message, extra].filter(Boolean).join(' ')
  console.log(`[io:${operation}] ${status}${fmtMs(elapsedMs)}${tail ? ` — ${tail}` : ''}`)
}

export function logRequest(operation, { method, url, path: reqPath, headers, body, meta } = {}, { debug } = {}) {
  const dbg = debug ?? debugEnabled
  if (!dbg) return
  const h = headers ? ` headers=${JSON.stringify(maskHeaders(headers))}` : ''
  const b = body !== undefined ? ` body=${JSON.stringify(maskBody(body)).slice(0, PREVIEW_LIMIT)}` : ''
  const m = meta ? ` ${JSON.stringify(meta).slice(0, 500)}` : ''
  const line = `${method || ''} ${url || reqPath || ''}${h}${b}${m}`.trim()
  console.log(`[io:${operation}][debug] → ${line}`)
}

export function logResponse(operation, { status, statusText, headers, body, bytes, elapsedMs, output, truncated, meta } = {}, { debug } = {}) {
  const dbg = debug ?? debugEnabled
  if (!dbg) return
  const st = status != null ? `HTTP ${status}${statusText ? ` ${statusText}` : ''}` : ''
  const h = headers ? ` headers=${JSON.stringify(headers).slice(0, 800)}` : ''
  const b = body !== undefined ? ` body=${String(body).slice(0, PREVIEW_LIMIT)}${truncated ? ' …(截断)' : ''}` : ''
  const out = output !== undefined ? ` output=${String(output).slice(0, PREVIEW_LIMIT)}` : ''
  const m = meta ? ` ${JSON.stringify(meta).slice(0, 500)}` : ''
  const line = [st, bytes != null ? `bytes=${bytes}` : '', `${elapsedMs ?? ''}ms`, h, b, out, m].filter(Boolean).join(' ')
  console.log(`[io:${operation}][debug] ← ${line}`)
}
