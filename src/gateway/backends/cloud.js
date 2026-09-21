// ============================================================
// CloudBackend — 隧道转发到云端 Worker（→ CF AI Gateway → 厂商）
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §5、§4.2）：
//   本地仅作隧道，把请求转发到 gateway.json.cloudWorkerUrl 指向的云端
//   Worker；Authorization 决策：客户端携带则透传，否则注入本地保存的
//   gateway token（cfut_xxx）；响应（含 SSE）原样透传。
//
// 依赖经工厂参数注入，测试可整体 mock。
// ============================================================

import { readToken as defaultReadToken } from '../../core/token-store.js'

const DEFAULT_TIMEOUT_MS = 120000

/**
 * 构造 JSON 错误响应
 * @param {number} status
 * @param {string} error
 * @returns {Response}
 */
function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 归一化 Worker 基础地址并拼出 chat 端点
 * @param {string} cloudWorkerUrl
 * @returns {string}
 */
function buildCloudChatUrl(cloudWorkerUrl) {
  let u
  try {
    u = new URL(String(cloudWorkerUrl).trim())
  } catch {
    throw new Error('cloudWorkerUrl 非法')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('cloudWorkerUrl 必须以 http:// 或 https:// 开头')
  }
  const base = u.toString().replace(/\/+$/, '')
  return `${base}/v1/chat/completions`
}

/**
 * 创建云端后端
 * @param {object} deps
 * @param {string} deps.cloudWorkerUrl - 云端 Worker 地址
 * @param {Function} [deps.fetchFn] - (url, init) => Promise<Response>
 * @param {Function} [deps.readGatewayToken] - () => cfut token | null
 * @param {number} [deps.timeoutMs]
 */
export function createCloudBackend(deps = {}) {
  const {
    cloudWorkerUrl = '',
    fetchFn = globalThis.fetch,
    readGatewayToken = defaultReadToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps

  return {
    type: 'cloud',

    /**
     * 处理 chat 请求
     * @param {{ bodyText: string, headers: Headers }} request
     * @returns {Promise<Response>}
     */
    async chat({ bodyText, headers: incomingHeaders }) {
      if (!cloudWorkerUrl) {
        return jsonError(400, "cloud 模式未配置 cloudWorkerUrl，请在 data/gateway.json 中填写云端 Worker 地址")
      }

      let targetUrl
      try {
        targetUrl = buildCloudChatUrl(cloudWorkerUrl)
      } catch (err) {
        return jsonError(400, err instanceof Error ? err.message : String(err))
      }

      const headers = new Headers()
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', 'text/event-stream')

      const clientAuth = incomingHeaders?.get('Authorization')
      if (clientAuth) {
        headers.set('Authorization', clientAuth)
      } else {
        const token = readGatewayToken()
        if (!token) {
          return jsonError(
            400,
            '缺少转发凭证：客户端未携带 Authorization，且本地未保存 gateway token（cfut_xxx）'
          )
        }
        headers.set('Authorization', `Bearer ${token}`)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return await fetchFn(targetUrl, {
          method: 'POST',
          headers,
          body: bodyText,
          signal: controller.signal,
        })
      } catch (err) {
        const aborted = err?.name === 'AbortError'
        const message = aborted
          ? `转发云端 Worker 超时（${timeoutMs}ms）`
          : `转发云端 Worker 失败: ${err instanceof Error ? err.message : String(err)}`
        return jsonError(502, message)
      } finally {
        clearTimeout(timer)
      }
    },

    /**
     * 后端健康检查（仅校验配置，不触网）
     * @returns {Promise<object>}
     */
    async health() {
      return { type: 'cloud', configured: Boolean(cloudWorkerUrl) }
    },
  }
}
