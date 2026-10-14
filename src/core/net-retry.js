/**
 * 网络瞬时失败的识别、根因展开与退避重试
 * @module ai-gateway-desk/src/core/net-retry
 *
 * 背景：部分网络环境下 Node 直连 api.cloudflare.com / gateway.ai.cloudflare.com
 * 会在「连接建立」阶段偶发超时（undici 默认连接超时 10s，实测本机偶发需要 12s+），
 * 对外只表现为笼统的 `TypeError: fetch failed`，真正原因藏在 `err.cause` 里
 * （如 UND_ERR_CONNECT_TIMEOUT）。本模块提供：
 *   - describeNetworkError：把 "fetch failed" 展开为「根因 + 目标主机」，便于定位；
 *   - isRetriableNetworkError：识别连接阶段瞬时错误（请求尚未发出，重试无副作用）；
 *   - withNetworkRetry：按退避策略重试上述瞬时错误。
 *
 * 注意：只重试「连接阶段」错误（DNS/连接超时、拒绝连接），不重试读超时或
 * 已发出请求后的错误，避免对非幂等操作产生副作用。
 */

/** 连接阶段（请求尚未发出）的瞬时错误码：重试无副作用 */
export const RETRIABLE_NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DNS_RESOLVE_FAILED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
])

/**
 * 是否为连接阶段瞬时错误（可安全重试）
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetriableNetworkError(err) {
  const code = err && err.cause && err.cause.code
  return typeof code === 'string' && RETRIABLE_NETWORK_CODES.has(code)
}

/**
 * 把 undici 的笼统 "fetch failed" 展开为带根因与目标主机的可读文案
 * @param {unknown} err
 * @param {string} [url] - 目标 URL（仅取 host 展示）
 * @returns {string} 如：`fetch failed（UND_ERR_CONNECT_TIMEOUT @ api.cloudflare.com）`
 */
export function describeNetworkError(err, url = '') {
  const base = err instanceof Error ? err.message : String(err)
  const cause = err && err.cause
  const detail = cause && (cause.code || cause.message)
  let host = ''
  try {
    host = url ? new URL(url).host : ''
  } catch {
    /* 非法 URL：不展示 host */
  }
  if (!detail) return host && !base.includes(host) ? `${base} @ ${host}` : base
  const at = host && !base.includes(host) ? ` @ ${host}` : ''
  return `${base}（${String(detail).slice(0, 160)}${at}）`
}

/** 等待指定毫秒 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 执行一个可能因网络瞬时失败的操作，连接阶段失败时按退避策略重试。
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=2] - 额外重试次数（合计最多 retries+1 次尝试）
 * @param {number} [opts.baseDelayMs=600] - 退避基数（第 n 次重试等待 n*baseDelayMs）
 * @param {(info: { attempt: number, waitMs: number, detail: string }) => void} [opts.onRetry] - 每次重试前回调（用于日志）
 * @returns {Promise<T>}
 */
export async function withNetworkRetry(fn, { retries = 2, baseDelayMs = 600, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt < retries && isRetriableNetworkError(err)) {
        const waitMs = baseDelayMs * (attempt + 1)
        if (onRetry) {
          try {
            onRetry({ attempt: attempt + 1, waitMs, detail: describeNetworkError(err) })
          } catch {
            /* 日志回调异常不影响重试 */
          }
        }
        await delay(waitMs)
        continue
      }
      throw err
    }
  }
}
