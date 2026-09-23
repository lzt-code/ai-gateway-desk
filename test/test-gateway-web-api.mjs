/**
 * 网关视图 API 测试 — createApp + 全 mock deps：
 * GET  /api/gateway/overview（运行/未运行、凭证行、workerEndpoints 自动发现）
 * POST /api/gateway/backfill-keys（本进程拉取）
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
function makeGatewayFetch(running) {
  const calls = []
  const fetchFn = async (url) => {
    const u = String(url)
    calls.push({ url: u })
    if (u.endsWith('/health')) {
      if (!running) throw new TypeError('ECONNREFUSED')
      return new Response(
        JSON.stringify({ ok: true, backend: { type: 'local' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { fetchFn, calls }
}

const discovered = {
  workersDev: 'https://ai-gateway-desk-worker.my-sub.workers.dev',
  customDomains: ['ai.example.com'],
  routes: ['https://<子域>.laoliu-dev.uk/api/v1'],
  error: '',
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
  section('1. GET /api/gateway/overview：网关运行中 + 凭证状态 + 地址发现')
  {
    tmpDir = makeDataDir(
      { port: 8788 },
      providersConfig
    )
    const { fetchFn, calls } = makeGatewayFetch(true)
    const discoverCalls = []
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ port: 8788 }),
        readManagementToken: () => 'mgmt-token',
        discoverWorkerEndpoints: async (token, accountId) => {
          discoverCalls.push({ token, accountId })
          return discovered
        },
        hasProviderKeyFn: null,
      },
    })
    const res = await app.request('/api/gateway/overview')
    const body = await res.json()
    check(res.status === 200, '200')
    check(body.running === true, 'running=true')
    check(
      body.workerEndpoints.workersDev === discovered.workersDev,
      'workerEndpoints.workersDev 回显'
    )
    check(
      body.workerEndpoints.customDomains[0] === 'ai.example.com',
      'workerEndpoints.customDomains 回显'
    )
    check(!('workerUrl' in body), '不再返回 workerUrl')
    check(body.baseUrl === 'http://127.0.0.1:8788/v1', 'baseUrl 正确')
    check(body.providers.length === 2, '返回 2 个 provider 凭证行')
    check(
      body.providers[0].slug === 'custom-fang-zhou',
      `provider slug（实际 ${body.providers[0].slug}）`
    )
    check(calls.some((c) => c.url.endsWith('/health')), '探测了 /health')
    check(discoverCalls.length === 1, '调用了 discoverWorkerEndpoints')
    check(
      discoverCalls[0].token === 'mgmt-token' && discoverCalls[0].accountId === 'acc-1',
      '发现调用携带 token + accountId'
    )
  }

  section('2. overview：网关未运行')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ port: 8788 }),
        readManagementToken: () => 'mgmt-token',
        discoverWorkerEndpoints: async () => discovered,
      },
    })
    const res = await app.request('/api/gateway/overview')
    const body = await res.json()
    check(body.running === false, 'running=false')
    check(
      body.workerEndpoints.workersDev === discovered.workersDev,
      '未运行时仍做地址发现'
    )
  }

  section('3. overview：无管理 Token → error 不报错')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ port: 8788 }),
        readManagementToken: () => null,
        discoverWorkerEndpoints: async () => {
          throw new Error('不应被调用')
        },
      },
    })
    const res = await app.request('/api/gateway/overview')
    const body = await res.json()
    check(res.status === 200, '200')
    check(body.workerEndpoints.workersDev === '', 'workersDev 空串')
    check(body.workerEndpoints.customDomains.length === 0, 'customDomains 空')
    check(body.workerEndpoints.routes.length === 0, 'routes 空')
    check(body.workerEndpoints.error.includes('aigd setup'), '引导 setup')
  }

  section('4. backfill：无管理 Token → 400')
  {
    const { fetchFn } = makeGatewayFetch(false)
    const app = createTestApp({
      deps: {
        gatewayFetch: fetchFn,
        readGatewayConfig: () => ({ port: 8788 }),
        readManagementToken: () => null,
      },
    })
    const res = await app.request('/api/gateway/backfill-keys', { method: 'POST' })
    check(res.status === 400, '400 提示手工录入')
  }

  section('5. backfill：本进程拉云端写本地')
  {
    const { fetchFn: gatewayFetchFn } = makeGatewayFetch(false)
    const keyWrites = []
    const app = createTestApp({
      configStore: makeStore(providersConfig),
      deps: {
        gatewayFetch: gatewayFetchFn,
        readGatewayConfig: () => ({ port: 8788 }),
        readManagementToken: () => 'mgmt-token',
        listCloudCustomProviders: async () => [
          {
            slug: 'fang-zhou',
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

  section('6. POST provider-key：手工录入 BYOK Key')
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

  section('7. provider-key：缺 slug / 缺 key → 400')
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
