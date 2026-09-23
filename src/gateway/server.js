// ============================================================
// 本地网关服务器 — OpenAI 兼容端点 + 网关管理 API
// ============================================================
// createGatewayApp(deps)：Hono app 工厂，依赖注入（配置存储 / 凭证 /
//   backend 工厂 / fetch 等），对齐 src/web/server.js 的可测模式。
// startGateway(...)：独立启动器，@hono/node-server，仅绑定 127.0.0.1，
//   固定端口、无心跳退出（与 web 管理服务器刻意区分）。
//
// 端点：
//   POST /v1/chat/completions     进入 LocalBackend（本机出口 IP 直发）
//   GET  /v1/models               读本地 data/models.json
//   GET  /health                  进程存活 + backend 健康
//   GET  /api/gateway/status      端口 / 各 provider 凭证状态
//   POST /api/gateway/backfill-keys  custom-provider 完整 key 云端回填
// ============================================================

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  loadGatewayConfig as defaultLoadGatewayConfig,
} from './config-store.js'
import {
  writeProviderHeaders as defaultWriteProviderHeaders,
  hasProviderKey as defaultHasProviderKey,
} from './provider-keys.js'
import { loadRawProvidersConfig } from './provider-lookup.js'
import { gatewaySlug } from '../cloudflare/discover.js'
import { createLocalBackend } from './backends/local.js'
import { listCustomProviders } from '../cloudflare/api.js'
import { readManagementToken as defaultReadManagementToken } from '../core/token-store.js'
import { logResult } from '../core/io-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 data/ */
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

/**
 * 读取本地 models.json（数组形式）
 * @param {string} [dataDir]
 * @returns {Array<object>}
 * @throws 文件缺失 / 损坏时抛错
 */
export function readModelsList(dataDir = DEFAULT_DATA_DIR) {
  const text = fs.readFileSync(path.join(dataDir, 'models.json'), 'utf8')
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('models.json 内容不是数组')
  return parsed
}

/**
 * 默认 backend 工厂：本地直发
 * @returns {object}
 */
export function defaultBackendFactory() {
  return createLocalBackend()
}

/**
 * 解析 listCustomProviders 返回条目的完整 headers（JSON 字符串 → 对象）
 * @param {unknown} rawHeaders
 * @returns {Record<string, string>|null}
 */
function parseCloudHeaders(rawHeaders) {
  if (typeof rawHeaders !== 'string') return null
  try {
    const parsed = JSON.parse(rawHeaders)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return /** @type {Record<string, string>} */ (parsed)
    }
  } catch {
    // 解析失败返回 null
  }
  return null
}

/**
 * 创建本地网关 Hono 应用（依赖注入，可测）
 * @param {object} [options]
 * @param {string} [options.dataDir] - 数据目录（默认项目 data/）
 * @param {Function} [options.loadConfig] - () => gateway 配置
 * @param {Function} [options.backendFactory] - () => backend 实例
 * @param {Function} [options.readModels] - () => model 数组
 * @param {Function} [options.hasProviderKey] - (slug) => boolean
 * @param {Function} [options.writeProviderHeaders] - (slug, headers) => void
 * @param {Function} [options.listCloudCustomProviders] - (token, accountId) => 数组
 * @param {Function} [options.readManagementToken] - () => token | null
 * @returns {Hono}
 */
export function createGatewayApp(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR
  const loadConfig =
    options.loadConfig || (() => defaultLoadGatewayConfig(dataDir))
  const backendFactory = options.backendFactory || defaultBackendFactory
  const readModels = options.readModels || (() => readModelsList(dataDir))
  const hasKey = options.hasProviderKey || defaultHasProviderKey
  const writeHeaders = options.writeProviderHeaders || defaultWriteProviderHeaders
  const listCloudCustomProviders =
    options.listCloudCustomProviders || listCustomProviders
  const readMgmtToken = options.readManagementToken || defaultReadManagementToken

  const app = new Hono()

  let gatewayConfig = loadConfig()
  let backend = backendFactory(gatewayConfig)

  // ─── CORS：动态回显预检所需头（对齐 Worker 行为） ───
  app.use('*', async (c, next) => {
    const reqHeaders = c.req.header('Access-Control-Request-Headers')
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Origin', '*')
      c.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE')
      c.header('Access-Control-Max-Age', '86400')
      if (reqHeaders) c.header('Access-Control-Allow-Headers', reqHeaders)
      else c.header('Access-Control-Allow-Headers', '*')
      return c.body(null, 204)
    }
    await next()
    c.header('Access-Control-Allow-Origin', '*')
  })

  // POST /v1/chat/completions — 进入本地直发 backend
  app.post('/v1/chat/completions', async (c) => {
    const bodyText = await c.req.text()
    return backend.chat({ bodyText, headers: c.req.raw.headers })
  })

  // GET /v1/models — 读本地 models.json
  app.get('/v1/models', (c) => {
    const op = 'gateway:models'
    const start = Date.now()
    try {
      const data = readModels()
      logResult(op, { ok: true, message: `${data.length} 个模型`, elapsedMs: Date.now() - start })
      return c.json({ object: 'list', data })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
      return c.json(
        { error: `读取本地 models.json 失败: ${message}` },
        503
      )
    }
  })

  // GET /health — 进程存活 + backend 健康
  app.get('/health', async (c) => {
    let backendHealth = {}
    try {
      backendHealth = await backend.health()
    } catch (err) {
      backendHealth = { error: err instanceof Error ? err.message : String(err) }
    }
    return c.json({ ok: true, backend: backendHealth })
  })

  // GET /api/gateway/status — 端口 / 各 provider 凭证状态
  app.get('/api/gateway/status', (c) => {
    const op = 'gateway:status'
    const start = Date.now()
    const raw = loadRawProvidersConfig(dataDir)
    const providerKeys = (raw.providers || []).map((p) => {
      const resolvedSlug = gatewaySlug(p)
      let keySaved = false
      try {
        keySaved = hasKey(resolvedSlug)
      } catch {
        keySaved = false
      }
      return {
        slug: resolvedSlug,
        id: p?.id,
        name: p?.name,
        type: p?.type,
        keySaved,
        needsReEntry: !keySaved && p?.type === 'byok',
      }
    })
    logResult(op, {
      ok: true,
      message: `${providerKeys.length} 个 provider`,
      elapsedMs: Date.now() - start,
    })
    return c.json({
      port: gatewayConfig.port,
      providers: providerKeys,
    })
  })

  // POST /api/gateway/backfill-keys — 云端 custom-provider 完整 headers 回填本地
  app.post('/api/gateway/backfill-keys', async (c) => {
    const op = 'gateway:backfill'
    const start = Date.now()
    const mgmtToken = process.env.CLOUDFLARE_API_TOKEN || readMgmtToken()
    if (!mgmtToken) {
      const message = '本地未配置管理 API Token，无法从云端拉取凭证；请先运行 aigd setup 或手工录入 Key'
      logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
      return c.json({ error: message }, 400)
    }

    const raw = loadRawProvidersConfig(dataDir)
    const accountId = raw.gateway?.accountId
    if (!accountId) {
      const message = 'providers.json 缺少 gateway.accountId，请先完成 setup'
      logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
      return c.json({ error: message }, 400)
    }

    let cloudList
    try {
      cloudList = await listCloudCustomProviders(mgmtToken, accountId)
    } catch (err) {
      const message = `拉取云端 custom providers 失败: ${err instanceof Error ? err.message : String(err)}`
      logResult(op, { ok: false, message, elapsedMs: Date.now() - start })
      return c.json({ error: message }, 502)
    }

    const backfilled = []
    const skipped = []
    const errors = []

    for (const item of Array.isArray(cloudList) ? cloudList : []) {
      const slug = item?.slug
      if (!slug) {
        skipped.push({ slug: '(unknown)', reason: '缺少 slug' })
        continue
      }
      const headers = parseCloudHeaders(item.headers)
      if (!headers) {
        skipped.push({ slug, reason: 'headers 缺失或无法解析' })
        continue
      }
      // 云端 custom-provider slug 不带 custom- 前缀，本地按 gatewaySlug 存取
      const localSlug = gatewaySlug({ id: slug, type: 'custom-provider' })
      try {
        writeHeaders(localSlug, headers)
        backfilled.push(localSlug)
      } catch (err) {
        errors.push({ slug, error: err instanceof Error ? err.message : String(err) })
      }
    }

    logResult(op, {
      ok: errors.length === 0,
      message: `backfilled=${backfilled.length} skipped=${skipped.length} errors=${errors.length}`,
      elapsedMs: Date.now() - start,
    })
    return c.json({ ok: errors.length === 0, backfilled, skipped, errors })
  })

  app.onError((err, c) => {
    console.error('[gateway] 错误:', err)
    return c.json({ error: err.message || 'internal gateway error' }, 500)
  })

  return app
}

/**
 * 独立启动器：固定端口、仅绑 127.0.0.1、无心跳退出。
 * @param {object} [options]
 * @param {number} [options.port] - 端口（默认取 gateway.json / 8788）
 * @param {string} [options.hostname] - 绑定地址，固定默认 127.0.0.1
 * @param {boolean} [options.installSignalHandlers]
 * @returns {Promise<{ server: object, port: number, close: Function }>}
 */
export function startGateway(options = {}) {
  const hostname = options.hostname || '127.0.0.1'
  const installSignalHandlers = options.installSignalHandlers !== false

  const initialConfig = defaultLoadGatewayConfig()
  const port = options.port || initialConfig.port

  const app = createGatewayApp()

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const close = () =>
        new Promise((res) => {
          server.close(() => res())
        })

      const shutdown = async () => {
        try {
          await close()
        } finally {
          process.exit(0)
        }
      }

      if (installSignalHandlers) {
        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)
      }

      resolve({ server, port: info.port, close })
    })

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用：可能已有一个网关在运行，或被其他程序占用，请先关闭或更换端口`
          )
        )
      } else {
        reject(err)
      }
    })
  })
}
