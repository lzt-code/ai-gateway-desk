/**
 * 双网关视图 API 测试 — createApp + 全 mock deps：
 * GET  /api/gateway/overview（运行/未运行、凭证行）
 * POST /api/gateway/mode（运行时代理热切换 / 未运行写文件）
 * POST /api/gateway/cloud-url
 * POST /api/gateway/backfill-keys（代理 / 本进程拉取）
 * POST /api/gateway/provider-key
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createApp } from '../src/web/server.js'

const createTestApp = (options = {}) =>
  createApp(Object.assign({ autoDeployIdleMs: 0 }, options))

let failures = 0
let checks = 0

function check(cond, msg) {
  checks++
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

function makeStore(initial = {}) {
  const saves = []
  const store = {
    state: structuredClone(initial),
    saves,
    load: () => store.state,
    save: (s) => {
      saves.push(s)
    },
  }
  return store
}

// ── 临时目录：gateway.json + providers.json ──
function makeDataDir(gatewayConfig, providersConfig) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aigd-gw-api-'))
  if (gatewayConfig) {
    writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify(gatewayConfig))
  }
  if (providersConfig) {
    writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(providersConfig))
  }
  return dir
}

// ── mock gatewayFetch：按 health 存活与否返回 ──
function makeGatewayFetch(running, modeHandler) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    if (u.endsWith('/health')) {
      if (!running) throw new TypeError('ECONNREFUSED')
      return new Response(
        JSON.stringify({ ok: true, mode: 'local', backend: { type: 'local' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    if (modeHandler) return modeHandler(u, init)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetchFn, calls }
}

const providersConfig = {
  gateway: { accountId: 'acc-1', gatewayId: 'gw-1' },
  kv: { namespaceId: 'ns-1' },
  providers: [
    {
      id: 'fang-zhou',
      name: '方舟',
      type: 'custom-provider',
      base_url: 'https://ark.example.com',
    },
    { id: 'openai', name: 'OpenAI', type: 'byok' },
  ],
}

let tmpDir
try {
  section('1. GET /api/gateway/overview：网关运行中 + 凭证状态')
  {
    tmpDir = makeDataDir(
      { mode: 'local', port: 8788, cloudWorkerUrl: 'https://w.example.com' },
      providersConfig
    )
    const { fetchFn, calls } = makeGatewayFetch(true)
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({
          mode: 'local',
          port: 8788,
          cloudWorkerUrl: 'https://w.example.com',
        }),
        hasProviderKeyFn: null,
      },
    })
    // hasProviderKey 默认走真实加密存储：覆盖 deps 不行（overview 用的是直接 import 的 hasProviderKey）
    const res = await app.request('/api/gateway/overview')
    const body = await res.json()
    check(res.status === 200, '200')
    check(body.running === true, 'running=true')
    check(body.mode === 'local', 'mode=local')
    check(body.baseUrl === 'http://127.0.0.1:8788/v1', 'baseUrl 正确')
    check(body.providers.length === 2, '返回 2 个 provider 凭证行')
    check(
      body.providers[0].slug === 'custom-fang-zhou',
      `provider slug（实际 ${body.providers[0].slug}）`
    )
    check(calls.some((c) => c.url.endsWith('/health')), '探测了 /health')
  }

  section('2. overview：网关未运行')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'cloud', port: 8788, cloudWorkerUrl: '' }),
      },
    })
    const res = await app.request('/api/gateway/overview')
    const body = await res.json()
    check(body.running === false, 'running=false')
    check(body.mode === 'cloud', 'mode=cloud')
    const byok = body.providers.find((p) => p.id === 'openai')
    check(byok.needsReEntry === true, 'BYOK 缺 key 标记需重新录入')
  }

  section('3. POST mode：网关运行中 → 代理热切换')
  {
    const modeCalls = []
    const { fetchFn } = makeGatewayFetch(true, (url, init) => {
      modeCalls.push({ url, body: init.body })
      return new Response(JSON.stringify({ ok: true, mode: 'cloud' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    let savedToFile = null
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
        saveGatewayConfig: (cfg) => {
          savedToFile = cfg
          return cfg
        },
      },
    })
    const res = await app.request('/api/gateway/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'cloud' }),
    })
    const body = await res.json()
    check(body.ok === true, 'ok')
    check(body.hotSwapped === true, 'hotSwapped=true')
    check(savedToFile === null, '热切换时不写文件')
    check(modeCalls[0].url.includes('/api/gateway/mode'), '代理到网关 mode API')
    check(modeCalls[0].body === JSON.stringify({ mode: 'cloud' }), '携带 mode')
  }

  section('4. POST mode：网关未运行 → 写 gateway.json')
  {
    const { fetchFn } = makeGatewayFetch(false)
    let savedToFile = null
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'cloud', port: 8788, cloudWorkerUrl: '' }),
        saveGatewayConfig: (cfg) => {
          savedToFile = cfg
          return cfg
        },
      },
    })
    const res = await app.request('/api/gateway/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'local' }),
    })
    const body = await res.json()
    check(body.ok && body.hotSwapped === false, 'ok，非热切换')
    check(savedToFile && savedToFile.mode === 'local', '写入文件 mode=local')
  }

  section('5. POST mode：非法 mode → 400')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
      },
    })
    const res = await app.request('/api/gateway/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus' }),
    })
    check(res.status === 400, '400')
  }

  section('6. POST cloud-url：保存 Worker 地址')
  {
    let saved = null
    const app = createTestApp({
      deps: {
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
        saveGatewayConfig: (cfg) => {
          saved = cfg
          return cfg
        },
      },
    })
    const res = await app.request('/api/gateway/cloud-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cloudWorkerUrl: 'https://x.workers.dev' }),
    })
    const body = await res.json()
    check(body.ok && body.cloudWorkerUrl === 'https://x.workers.dev', '已保存')
    check(saved.port === 8788, '保留其他字段')
  }

  section('7. POST backfill-keys：网关运行中 → 代理')
  {
    const proxied = []
    const { fetchFn } = makeGatewayFetch(true, (url) => {
      proxied.push(url)
      return new Response(
        JSON.stringify({ ok: true, backfilled: ['custom-fang-zhou'], skipped: [], errors: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
      },
    })
    const res = await app.request('/api/gateway/backfill-keys', { method: 'POST' })
    const body = await res.json()
    check(body.backfilled.length === 1, '回填 1 个')
    check(proxied.some((u) => u.includes('backfill-keys')), '代理到网关回填 API')
  }

  section('8. backfill：网关未运行 + 无管理 Token → 400')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
        readManagementToken: () => null,
      },
    })
    const res = await app.request('/api/gateway/backfill-keys', { method: 'POST' })
    check(res.status === 400, '400 提示手工录入')
  }

  section('9. backfill：网关未运行 → 本进程拉云端写本地')
  {
    const { fetchFn: gatewayFetchFn } = makeGatewayFetch(false)
    const keyWrites = []
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: gatewayFetchFn,
        readGatewayConfig: () => ({ mode: 'local', port: 8788, cloudWorkerUrl: '' }),
        readManagementToken: () => 'mgmt-token',
        listCloudCustomProviders: async () => [
          {
            slug: 'custom-fang-zhou',
            headers: JSON.stringify({ Authorization: 'Bearer sk-cloud' }),
          },
          { slug: 'bad', headers: 'not-json' },
        ],
        writeProviderKey: (slug, headers) => keyWrites.push({ slug, headers }),
      },
    })
    const res = await app.request('/api/gateway/backfill-keys', { method: 'POST' })
    const body = await res.json()
    check(body.backfilled.length === 1 && body.backfilled[0] === 'custom-fang-zhou', '回填 1 个')
    check(body.skipped.length === 1, '跳过 1 个（坏 headers）')
    check(keyWrites[0].headers.Authorization === 'Bearer sk-cloud', '写入完整 headers')
  }

  section('10. POST provider-key：手工录入 BYOK Key')
  {
    const writes = []
    const app = createTestApp({
      deps: {
        writeProviderKey: (slug, headers) => writes.push({ slug, headers }),
      },
    })
    const res = await app.request('/api/gateway/provider-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'openai', apiKey: 'sk-xxx' }),
    })
    const body = await res.json()
    check(body.ok && body.slug === 'openai', 'ok')
    check(writes[0].headers.Authorization === 'Bearer sk-xxx', 'Bearer 形式写入')
  }

  section('11. provider-key：缺 slug / 缺 key → 400')
  {
    const app = createTestApp({ deps: { writeProviderKey: () => {} } })
    let res = await app.request('/api/gateway/provider-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'x' }),
    })
    check(res.status === 400, '缺 slug → 400')
    res = await app.request('/api/gateway/provider-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'openai' }),
    })
    check(res.status === 400, '缺 apiKey → 400')
  }
} finally {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
