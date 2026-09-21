/**
 * 网关服务器测试 — 全部端点（DI mock，不触网络 / 磁盘 / 真实凭证）
 * 覆盖：chat / models / health / mode GET+POST（热切换）/ status / backfill
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
let currentConfig = { mode: 'local', port: 8788, cloudWorkerUrl: 'https://w.example.com' }
let chatCalls = []
let backendInstances = []

function makeMockBackend(mode) {
  backendInstances.push(mode)
  return {
    type: mode,
    chat: async ({ bodyText }) => {
      chatCalls.push({ mode, bodyText })
      return new Response(`echo:${mode}`, { status: 200 })
    },
    health: async () => ({ type: mode, ok: true }),
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
  saveConfig: (cfg) => {
    currentConfig = { ...currentConfig, ...cfg }
    return currentConfig
  },
  backendFactory: (cfg) => makeMockBackend(cfg.mode),
  readModels: () => [{ id: 'custom-fang-zhou/m1' }],
  hasProviderKey: (slug) => keyState.has(slug),
  writeProviderHeaders: (slug, headers) => keyState.set(slug, headers),
  listCloudCustomProviders: async () => [],
  readManagementToken: () => 'mgmt-token',
})

try {
  section('1. POST /v1/chat/completions 进入当前 backend')
  {
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'custom-fang-zhou/m1' }),
    })
    check(res.status === 200, '200')
    check((await res.text()) === 'echo:local', 'local backend 处理')
    check(chatCalls.length === 1 && chatCalls[0].mode === 'local', 'chat 调用记录 local')
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
    check(body.ok === true && body.mode === 'local', 'ok + mode=local')
    check(body.backend.type === 'local', 'backend 健康信息')
  }

  section('4. GET /api/gateway/mode')
  {
    const res = await app.request('/api/gateway/mode')
    const body = await res.json()
    check(body.mode === 'local' && body.port === 8788, '返回当前 mode/port')
  }

  section('5. POST /api/gateway/mode — 热切换')
  {
    const before = backendInstances.length
    let res = await app.request('/api/gateway/mode', {
      method: 'POST',
      body: JSON.stringify({ mode: 'cloud' }),
    })
    let body = await res.json()
    check(res.status === 200 && body.ok === true, '切换 cloud 成功')
    check(backendInstances.length === before + 1 && backendInstances.at(-1) === 'cloud', '工厂实例化 cloud backend')

    res = await app.request('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'x/y' }),
    })
    check((await res.text()) === 'echo:cloud', '切换后 chat 进入 cloud（热生效，无需重启）')

    res = await app.request('/api/gateway/mode', {
      method: 'POST',
      body: JSON.stringify({ mode: 'bad' }),
    })
    check(res.status === 400, '非法 mode → 400')
  }

  section('6. GET /api/gateway/status — 凭证状态')
  {
    const res = await app.request('/api/gateway/status')
    const body = await res.json()
    check(body.mode === 'cloud', '当前模式 cloud')
    check(body.cloudWorkerUrl === 'https://w.example.com', 'cloudWorkerUrl 回显')
    check(Array.isArray(body.providers) && body.providers.length === 2, '两个 provider')
    const ark = body.providers.find((p) => p.slug === 'custom-fang-zhou')
    const or = body.providers.find((p) => p.slug === 'openrouter')
    check(ark && ark.keySaved === false, '方舟 keySaved=false')
    check(or && or.needsReEntry === true, 'openrouter 无 key → needsReEntry=true')
  }

  section('7. POST /api/gateway/backfill-keys')
  {
    const backfillApp = createGatewayApp({
      dataDir: dir,
      loadConfig: () => currentConfig,
      saveConfig: (cfg) => cfg,
      backendFactory: () => makeMockBackend('local'),
      readModels: () => [],
      hasProviderKey: (slug) => keyState.has(slug),
      writeProviderHeaders: (slug, headers) => keyState.set(slug, headers),
      listCloudCustomProviders: async () => [
        {
          slug: 'custom-fang-zhou',
          headers: JSON.stringify({ Authorization: 'Bearer sk-full-key' }),
        },
        { slug: 'custom-noheaders' },
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
      body.skipped.some((s) => s.slug === 'custom-noheaders'),
      '无 headers 条目进入 skipped'
    )

    // 无管理 token → 400
    const noTokenApp = createGatewayApp({
      dataDir: dir,
      loadConfig: () => currentConfig,
      saveConfig: (cfg) => cfg,
      backendFactory: () => makeMockBackend('local'),
      readModels: () => [],
      hasProviderKey: () => false,
      writeProviderHeaders: () => {},
      listCloudCustomProviders: async () => [],
      readManagementToken: () => null,
    })
    res = await noTokenApp.request('/api/gateway/backfill-keys', { method: 'POST' })
    check(res.status === 400, '无管理 Token → 400')
  }

  section('8. CORS 预检')
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
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
