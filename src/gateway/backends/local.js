// ============================================================
// LocalBackend — 本机出口 IP 直发 AI 厂商
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §5、§4.1）：
//   解析 body.model 的 provider slug → 查 providers.json 条目
//   → 取本地加密凭证 headers → 构造厂商真实端点 → 本机直连，流式透传。
//
// 依赖全部经工厂参数注入（fetch / findProvider / 凭证读取 / 超时），
// 默认实现对齐生产环境，测试可整体 mock，不触真实网络与凭证。
// ============================================================

import { parseModelSlug, stripModelSlug, resolveProviderEndpoint } from '../router.js'
import { findProvider as defaultFindProvider } from '../provider-lookup.js'
import { readProviderHeaders as defaultReadProviderHeaders } from '../provider-keys.js'
import { createFallbackEngine } from '../fallback.js'
import { logRequest, logResponse, logResult } from '../../core/io-logger.js'

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
 * 创建本地后端
 * @param {object} [deps]
 * @param {Function} [deps.fetchFn] - (url, init) => Promise<Response>
 * @param {Function} [deps.findProvider] - (slug) => provider 条目 | null
 * @param {Function} [deps.readProviderHeaders] - (slug) => headers | null
 * @param {number} [deps.timeoutMs] - 上游请求超时，默认 120000
 * @param {object} [deps.fallbackEngine] - 动态路由引擎（默认 createFallbackEngine）
 */
export function createLocalBackend(deps = {}) {
  const {
    fetchFn = globalThis.fetch,
    findProvider = defaultFindProvider,
    readProviderHeaders = defaultReadProviderHeaders,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fallbackEngine = createFallbackEngine({
      fetchFn,
      findProvider,
      readProviderHeaders,
    }),
  } = deps

  return {
    type: 'local',

    /**
     * 处理 chat 请求
     * @param {{ bodyText: string }} request
     * @returns {Promise<Response>}
     */
    async chat({ bodyText }) {
      let body
      try {
        body = JSON.parse(bodyText)
      } catch {
        return jsonError(400, 'invalid json body')
      }
      if (!body || typeof body !== 'object') return jsonError(400, 'invalid json body')

      const parsed = parseModelSlug(body.model)
      if (!parsed) {
        return jsonError(
          400,
          "local 模式要求 model 形如 '<provider-slug>/<模型名>'"
        )
      }
      const { slug } = parsed

      // dynamic/<name>：进入本地 fallback 引擎（§10）
      if (slug === 'dynamic') {
        const routeName = parsed.upstream
        return fallbackEngine.execute(routeName, body)
      }

      const op = `gateway:chat:${slug}`
      const start = Date.now()

      const provider = findProvider(slug)
      if (!provider) {
        const message = `本地配置中找不到 provider '${slug}'`
        logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
        return jsonError(400, message)
      }

      let endpoint
      try {
        endpoint = resolveProviderEndpoint(provider)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
        return jsonError(400, message)
      }

      const credentialHeaders = readProviderHeaders(slug)
      if (!credentialHeaders) {
        const message =
          `本地缺少 provider '${slug}' 的凭证，请在管理界面回填 / 录入，或让 Agent 直连 Cloudflare 网关`
        logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
        return jsonError(400, message)
      }

      const forwardBody = JSON.stringify(stripModelSlug(body, slug))
      const headers = new Headers(credentialHeaders)
      headers.set('Content-Type', 'application/json')
      headers.set('Accept', 'text/event-stream')

      logRequest(op, {
        method: 'POST',
        url: endpoint,
        headers: Object.fromEntries(headers.entries()),
        body: forwardBody,
      })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchFn(endpoint, {
          method: 'POST',
          headers,
          body: forwardBody,
          signal: controller.signal,
        })
        const elapsed = Date.now() - start
        logResponse(op, {
          status: response.status,
          statusText: response.statusText,
          elapsedMs: elapsed,
        })
        logResult(op, {
          ok: response.ok,
          message: `HTTP ${response.status}`,
          elapsedMs: elapsed,
        })
        return response
      } catch (err) {
        const aborted = err?.name === 'AbortError'
        const message = aborted
          ? `请求 provider '${slug}' 超时（${timeoutMs}ms）`
          : `请求 provider '${slug}' 失败: ${err instanceof Error ? err.message : String(err)}`
        logResponse(op, { status: null, output: message, elapsedMs: Date.now() - start })
        logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
        return jsonError(502, message)
      } finally {
        clearTimeout(timer)
      }
    },

    /**
     * 后端健康 / 配置齐备性检查（不触网）
     * @returns {Promise<object>}
     */
    async health() {
      return { type: 'local', reachable: true }
    },
  }
}
