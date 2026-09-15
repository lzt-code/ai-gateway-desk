import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gatewaySlug } from '../cloudflare/discover.js'
import { writeKvValue } from '../cloudflare/kv.js'
import { readManagementToken } from '../core/token-store.js'
import { logRequest, logResult } from '../core/io-logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MODELS_JSON_PATH = path.resolve(__dirname, '..', '..', 'data', 'models.json')
const PROVIDER_ROUTES_KV_KEY = 'provider-routes'

/**
 * 解析管理 Token。优先级与原 wrangler 子进程方案一致：
 * process.env.CLOUDFLARE_API_TOKEN > 本地安全存储的管理 Token。
 * @returns {string} 未配置时返回空串
 */
function resolveMgmtToken() {
  return process.env.CLOUDFLARE_API_TOKEN || readManagementToken() || ''
}

/**
 * 从 provider 配置中提取路由映射（slug → pathPrefix）
 * @param {Array<object>} providers - provider 数组
 * @returns {string} JSON 字符串
 */
export function buildProviderRoutesJson(providers) {
  const routes = {}
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (p.pathPrefix && typeof p.pathPrefix === 'string') {
        // 必须用 gatewaySlug（custom- 前缀）作为键，与 worker 从 model id
        // 中解析出的 slug 以及 discover.js 写入 models.json 的前缀保持一致。
        // 用裸 id（如 fang-zhou）会导致 worker 查不到 pathPrefix，
        // 所有方舟请求回退到 /compat 端点。
        routes[gatewaySlug(p)] = p.pathPrefix
      }
    }
  }
  return JSON.stringify(routes)
}

/**
 * 仅将 provider 路由映射（provider-routes 键）写入 Cloudflare KV（REST API）。
 *
 * provider 的 pathPrefix 变更后由 Web 管理端即时调用，保证 worker 路由
 * 与本地配置一致；不写 models 键，与模型列表部署解耦。
 * 未配置 namespaceId（本地开发 / 未初始化 KV）→ skipped，不报错。
 *
 * @param {object} config - loadConfig() 返回的配置对象
 * @param {object} [config.kv] - KV 配置
 * @param {string} [config.kv.namespaceId] - KV namespace ID
 * @param {Array<object>} [config.providers] - provider 数组（用于提取路由映射）
 * @returns {Promise<{ success: true, skipped?: boolean } | { success: false, output: string }>}
 */
export async function deployProviderRoutesToKV(config) {
  const namespaceId = config?.kv?.namespaceId
  if (!namespaceId) return { success: true, skipped: true }
  const accountId = config?.gateway?.accountId || ''
  if (!accountId) return { success: false, output: '缺少 gateway.accountId 配置' }
  const token = resolveMgmtToken()
  if (!token) return { success: false, output: '缺少管理 Token（CLOUDFLARE_API_TOKEN 或本地安全存储）' }
  const routesJson = buildProviderRoutesJson(config.providers)
  try {
    await writeKvValue(token, accountId, namespaceId, PROVIDER_ROUTES_KV_KEY, routesJson)
    return { success: true }
  } catch (err) {
    return { success: false, output: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 将 data/models.json 部署到 Cloudflare KV（REST API）。
 * 同时写入 provider-routes 键（provider 路由映射）。
 *
 * 2026-09 起由 wrangler kv:key put 子进程改为 REST 写入（cloudflare/kv.js）：
 * models.json 全量 JSON 作为请求体直传，无命令行长度限制，无子进程秒级开销，
 * 与 hidden-models / manual-models / provider-visibility 的写入路径统一。
 *
 * @param {object} config - loadConfig() 返回的配置对象
 * @param {object} config.kv - KV 配置
 * @param {string} config.kv.namespaceId - KV namespace ID
 * @param {string} config.kv.key - KV key 名称（模型列表用）
 * @param {Array<object>} [config.providers] - provider 数组（用于提取路由映射）
 * @returns {Promise<{ success: boolean, output: string }>}
 */
export async function deployToKV(config) {
  const op = 'deploy:kv:models'
  const start = Date.now()
  logRequest(op, { path: MODELS_JSON_PATH, meta: { namespaceId: config?.kv?.namespaceId, key: config?.kv?.key } })
  // 检查 models.json 是否存在
  if (!existsSync(MODELS_JSON_PATH)) {
    const msg = `data/models.json 不存在：${MODELS_JSON_PATH}\n请先运行 generate 模块生成 models.json`
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  const { namespaceId, key } = config.kv || {}

  if (!namespaceId) {
    const msg = '缺少 kv.namespaceId 配置'
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  const accountId = config?.gateway?.accountId || ''
  if (!accountId) {
    const msg = '缺少 gateway.accountId 配置'
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  const token = resolveMgmtToken()
  if (!token) {
    const msg = '缺少管理 Token（CLOUDFLARE_API_TOKEN 或本地安全存储）'
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  // ─── 写入模型列表（REST，全量 JSON 文本作为请求体） ───
  const modelsJson = readFileSync(MODELS_JSON_PATH, 'utf8')
  try {
    await writeKvValue(token, accountId, namespaceId, key, modelsJson)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  // ─── 写入 provider 路由映射 ───
  const routesResult = await deployProviderRoutesToKV(config)

  if (!routesResult.success) {
    const msg = `模型列表已写入，但 provider 路由写入失败：${routesResult.output}`
    logResult(op, { ok: false, message: msg, elapsedMs: Date.now() - start })
    return {
      success: false,
      output: msg,
    }
  }

  logResult(op, { ok: true, message: 'ok', elapsedMs: Date.now() - start })
  return { success: true, output: 'ok' }
}
