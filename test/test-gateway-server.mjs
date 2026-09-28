/**
 * 网关服务器测试 — 全部端点（DI mock，不触网络 / 磁盘 / 真实凭证）
 * 覆盖：chat / models / health / status / backfill / CORS
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGatewayApp } from '../src/gateway/server.js'

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

const dir = mkdtempSync(path.join(tmpdir(), 'aigd-gw-server-'))

// ── mock 环境 ──
let currentConfig = { port: 8788 }
let chatCalls = []
let backendInstances = 0

function makeMockBackend() {
  backendInstances++
  return {
    type: 'local',
    chat: async ({ bodyText }) => {
      chatCalls.push({ bodyText })
      return new Response('echo:local', { status: 200 })
    },
    health: async () => ({ type: 'local', ok: true }),
  }
}

writeFileSync(
  path.join(dir, 'providers.json'),
  JSON.stringify({
    gateway: { accountId: 'acc-1', gatewayId: 'g-1' },
    providers: [
      { id: 'fang-zhou', type: 'custom-provider', name: '方舟' },
      { id: 'openrouter', type: 'byok', name: 'OR' },
    ],
  })
)

const keyState = new Map()

const app = createGatewayApp({
  dataDir: dir,
  loadConfig: () => currentConfig,
  backendFactory: () => makeMockBackend(),
  readModels: () => [{ id: 'custom-fang-zhou/m1' }],
  hasProviderKey: (slug) => keyState.has(slug),
  writeProviderHeaders: (slug, headers) => keyState.set(slug, headers),
  listCloudCustomProviders: async () => [],
  readManagementToken: () => 'mgmt-token',
})

try {
  section('1. POST /v1/chat/completions 进入本地 backend')
  {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'custom-fang-zhou/m1' }),
    })
    check(res.status === 200, '200')
    check((await res.text()) === 'echo:local', 'local backend 处理')
    check(chatCalls.length === 1, 'chat 调用记录一次')
  }

  section('2. GET /v1/models 本地 models.json 包装')
  {
    const res = await app.request('/v1/models')
    const body = await res.json()
    check(body.object === 'list', "object='list'")
    check(
      JSON.stringify(body.data) === JSON.stringify([{ id: 'custom-fang-zhou/m1' }]),
      'data 为本地 models'
    )
  }

  section('3. GET /health')
  {
    const res = await app.request('/health')
    const body = await res.json()
    check(body.ok === true, 'ok')
    check(body.backend.type === 'local', 'backend 健康信息')
  }

  section('4. GET /api/gateway/status — 凭证状态')
  {
    const res = await app.request('/api/gateway/status')
    const body = await res.json()
    check(body.port === 8788, '返回 port')
    check(Array.isArray(body.providers) && body.providers.length === 2, '两个 provider')
    const ark = body.providers.find((p) => p.slug === 'custom-fang-zhou')
    const or = body.providers.find((p) => p.slug === 'openrouter')
    check(ark && ark.keySaved === false, '方舟 keySaved=false')
    check(or && or.needsReEntry === true, 'openrouter 无 key → needsReEntry=true')
  }

  section('5. POST /api/gateway/backfill-keys')
  {
    const backfillApp = createGatewayApp({
      dataDir: dir,
      loadConfig: () => currentConfig,
      backendFactory: () => makeMockBackend(),
      readModels: () => [],
      hasProviderKey: (slug) => keyState.has(slug),
      writeProviderHeaders: (slug, headers) => keyState.set(slug, headers),
      listCloudCustomProviders: async () => [
        {
          slug: 'fang-zhou',
          headers: JSON.stringify({ Authorization: 'Bearer sk-full-key' }),
        },
        { slug: 'noheaders' },
      ],
      readManagementToken: () => 'mgmt-token',
    })

    let res = await backfillApp.request('/api/gateway/backfill-keys', { method: 'POST' })
    let body = await res.json()
    check(
      body.backfilled.includes('custom-fang-zhou'),
      '完整 headers 的 custom-provider 已回填'
    )
    check(
      keyState.get('custom-fang-zhou')?.Authorization === 'Bearer sk-full-key',
      '本地加密存储写入完整 key'
    )
    check(
      body.skipped.some((s) => s.slug === 'noheaders'),
      '无 headers 条目进入 skipped'
    )

    // 无管理 token → 400
    const noTokenApp = createGatewayApp({
      dataDir: dir,
      loadConfig: () => currentConfig,
      backendFactory: () => makeMockBackend(),
      readModels: () => [],
      hasProviderKey: () => false,
      writeProviderHeaders: () => {},
      listCloudCustomProviders: async () => [],
      readManagementToken: () => null,
    })
    res = await noTokenApp.request('/api/gateway/backfill-keys', { method: 'POST' })
    check(res.status === 400, '无管理 Token → 400')
  }

  section('6. CORS 预检')
  {
    const res = await app.request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Headers': 'x-stainless-lang, authorization' },
    })
    check(res.status === 204, 'OPTIONS → 204')
    check(
      res.headers.get('Access-Control-Allow-Headers') === 'x-stainless-lang, authorization',
      '动态回显请求头'
    )
  }

  section('7. POST /api/gateway/shutdown（管理界面关闭本进程）')
  {
    // 未注册钩子（非 startGateway 启动）→ 501
    const noHookApp = createGatewayApp({
      loadConfig: () => currentConfig,
      backendFactory: () => makeMockBackend(),
      readModels: () => [],
      hasProviderKey: () => false,
    })
    let res = await noHookApp.request('/api/gateway/shutdown', { method: 'POST' })
    check(res.status === 501, '未注册关闭钩子 → 501')

    // 已注册钩子：200 且异步触发钩子
    let shutdowns = 0
    const hookApp = createGatewayApp({
      loadConfig: () => currentConfig,
      backendFactory: () => makeMockBackend(),
      readModels: () => [],
      hasProviderKey: () => false,
      requestShutdown: () => {
        shutdowns++
      },
    })
    res = await hookApp.request('/api/gateway/shutdown', { method: 'POST' })
    check(res.status === 200, '200')
    check((await res.json()).ok === true, '响应 { ok:true }')
    check(shutdowns === 0, '响应先于关闭（同 tick 内不调用钩子）')
    await new Promise((r) => setTimeout(r, 5))
    check(shutdowns === 1, '异步触发关闭钩子')

    // 浏览器发起的请求（带 Origin）→ 403，不触发钩子
    res = await hookApp.request('/api/gateway/shutdown', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    check(res.status === 403, '带 Origin → 403')
    await new Promise((r) => setTimeout(r, 5))
    check(shutdowns === 1, '拒绝时未触发关闭钩子')

    // 非 POST → 404
    res = await hookApp.request('/api/gateway/shutdown', { method: 'GET' })
    check(res.status === 404, 'GET → 404')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
