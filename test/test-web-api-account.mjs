/**
 * 任务 29 验证脚本：Worker + 账户管理 API 端点
 *
 * 覆盖（交付包 §5 的 18 个用例）：GET /api/workers/status（已配置 / 未配置 KV /
 * models.json 缺失）、POST /api/workers/deploy（成功 / 失败 / 未配置 KV / 超时）、
 * GET /api/account/status（本地 / env 优先 / gateway 未配置）、
 * POST /api/account/update-token（成功 / 空 token / 非法 slot + 缺 token 字段）、
 * POST /api/account/clear-token（management / gateway 文案不同 / 非法 slot）、
 * POST /api/account/setup（spawn 参数断言）、任务 26/28 回归。
 *
 * 核心策略：全部依赖 mock（deps 注入），零触网零写盘零真实 spawn；
 * 部署超时时长经 deps.deployTimeoutMs 注入短值（50ms）；env 变量先清理、用后恢复。
 */

import { EventEmitter } from 'node:events'
import { createApp } from '../src/web/server.js'
import {
  summarizeTokenStatus,
  summarizeGatewayInfo,
  buildWorkersStatus,
} from '../src/tui/account-actions.js'

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

// ── fixtures ─────────────────────────────────────────────

function makeStore(initial = {}) {
  const saves = []
  const store = {
    state: structuredClone(initial),
    saves,
    load: () => store.state,
    save: (s) => {
      store.saves.push(s)
    },
  }
  return store
}

// fakeChild：EventEmitter 子类；close 经 setImmediate 回调；kill 记录调用；
// neverClose 时永不 close（超时测试用）
function makeFakeChild({ exitCode = 0, output = '', neverClose = false } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => {
    child.killed = true
  }
  child._emit = () => {
    if (child._closed) return
    child._closed = true
    if (output) child.stdout.emit('data', output)
    child.emit('close', exitCode)
  }
  child._neverClose = neverClose
  return child
}

// mock deps 工厂（交付包 §5.1）：纯函数绑定真实实现（无副作用）；
// 编排类 mock 记录调用；fetchCloudProviders 也 mock 掉（回归测试免触网）
function makeDeps(overrides = {}, spawnResult = {}) {
  const calls = []
  const deps = {
    calls,
    // 纯函数默认透传真实实现（无副作用）
    summarizeTokenStatus,
    summarizeGatewayInfo,
    buildWorkersStatus,
    // 编排类默认 mock（记录调用）
    updateToken: (slot, token) => {
      calls.push(['update', slot, token])
      return { ok: true }
    },
    clearSlotToken: (slot) => {
      calls.push(['clear', slot])
      return { ok: true }
    },
    checkKVKey: async (ns, key) => {
      calls.push(['kv', ns, key])
      return 'exists'
    },
    loadModelsJsonState: () => ({ exists: true, count: 12 }),
    readToken: () => 'cfut-local',
    readManagementToken: () => 'mgt-local',
    fetchCloudProviders: async () => ({ providers: [], errors: [] }),
    spawnFn: (cmd, args, opts) => {
      const child = makeFakeChild(spawnResult)
      calls.push(['spawn', cmd, args, opts, child])
      if (!child._neverClose) setImmediate(() => child._emit())
      return child
    },
    ...overrides,
  }
  return deps
}

// 配置 fixture：KV 已配置 / 未配置 KV / gateway 缺失
const kvConfig = {
  gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
  kv: { namespaceId: '2a3b4c5d6e7f8g9h0i1j2k3l', key: 'models' },
  providers: [],
}
const noKvConfig = {
  gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
  providers: [],
}
const noGatewayConfig = { providers: [] }

function makeApp(deps, { config = kvConfig, state = {} } = {}) {
  const store = makeStore(state)
  const app = createApp({
    configStore: { load: () => config },
    stateStore: store,
    deps,
  })
  return { app, store }
}

// env 清理：测试间不残留 CLOUDFLARE_API_TOKEN / GATEWAY_TOKEN（进程内共享）
function clearEnv() {
  delete process.env.CLOUDFLARE_API_TOKEN
  delete process.env.GATEWAY_TOKEN
}

async function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── Worker 状态 ──────────────────────────────────────────

section('GET /api/workers/status')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await app.request('/api/workers/status')
  const data = await res.json()
  check(res.status === 200, '测试 1: workers/status 返回 200')
  check(data.namespaceId === kvConfig.kv.namespaceId, '测试 1: namespaceId 正确')
  check(data.modelsJsonExists === true, '测试 1: modelsJsonExists true')
  check(data.modelCount === 12, '测试 1: modelCount 12')
  check(data.kvKeyExists === true, '测试 1: kvKeyExists true')
  check(data.canDeploy === true, '测试 1: canDeploy true')
  const kvCall = deps.calls.find((c) => c[0] === 'kv')
  check(
    kvCall && kvCall[1] === kvConfig.kv.namespaceId && kvCall[2] === 'models',
    '测试 1: checkKVKey 收到 (ns, models)'
  )
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps, { config: noKvConfig })
  const res = await app.request('/api/workers/status')
  const data = await res.json()
  check(res.status === 200 && data.namespaceId === '', '测试 2: 未配置 KV → namespaceId 空串')
  check(data.canDeploy === false, '测试 2: canDeploy false')
  check(data.kvKeyExists === false, '测试 2: kvKeyExists false')
  check(data.kvKey.status === 'skipped', '测试 2: kvKey.status skipped')
  check(data.modelsJsonExists === true && data.modelCount === 12, '测试 2: models.json 状态不受 KV 缺失影响')
  check(!deps.calls.some((c) => c[0] === 'kv'), '测试 2: 空 namespaceId 短路，checkKVKey 未被调')
}

{
  clearEnv()
  const deps = makeDeps({ loadModelsJsonState: () => ({ exists: false, count: null }) })
  const { app } = makeApp(deps)
  const res = await app.request('/api/workers/status')
  const data = await res.json()
  check(
    res.status === 200 && data.modelsJsonExists === false && data.modelCount === null,
    '测试 3: models.json 缺失 → modelsJsonExists false / modelCount null'
  )
}

// ── Worker 部署 ──────────────────────────────────────────

section('POST /api/workers/deploy')

{
  clearEnv()
  const deps = makeDeps({}, { exitCode: 0, output: 'Total Upload: 1.21 KiB / gzipped: 512 B' })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/workers/deploy', {})
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 4: 部署成功 200 ok')
  check(data.exitCode === 0, '测试 4: exitCode 0')
  check(data.output === 'Total Upload: 1.21 KiB / gzipped: 512 B', '测试 4: output 透传')
  const spawnCall = deps.calls.find((c) => c[0] === 'spawn')
  check(
    spawnCall && spawnCall[2][spawnCall[2].length - 1] === 'deploy',
    '测试 4: spawn args 尾为 deploy'
  )
}

{
  clearEnv()
  const deps = makeDeps({}, { exitCode: 1, output: '✘ [ERROR] deploy failed' })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/workers/deploy', {})
  const data = await res.json()
  check(res.status === 200 && data.ok === false, '测试 5: 失败退出码 → HTTP 200 ok:false')
  check(data.exitCode === 1, '测试 5: exitCode 1')
  check(data.output.includes('ERROR'), '测试 5: output 含 ERROR')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps, { config: noKvConfig })
  const res = await post(app, '/api/workers/deploy', {})
  const data = await res.json()
  check(res.status === 400 && data.error.includes('kv namespace'), '测试 6: 未配置 KV → 400')
  check(!deps.calls.some((c) => c[0] === 'spawn'), '测试 6: spawn 未被调')
}

{
  clearEnv()
  const deps = makeDeps({ deployTimeoutMs: 50 }, { neverClose: true })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/workers/deploy', {})
  const data = await res.json()
  check(res.status === 500 && data.error === 'deploy timeout', '测试 7: 超时 → 500 deploy timeout')
  const spawnCall = deps.calls.find((c) => c[0] === 'spawn')
  check(spawnCall && spawnCall[4].killed === true, '测试 7: child.kill 被调')
}

// ── 账户状态 ─────────────────────────────────────────────

section('GET /api/account/status')

{
  clearEnv()
  const deps = makeDeps({ readToken: () => 'cfut' })
  const { app } = makeApp(deps)
  const res = await app.request('/api/account/status')
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 8: account/status 200 ok')
  check(data.tokens.gateway.source === 'local', '测试 8: gateway 槽位 source local')
  check(data.tokens.management.source === 'local', '测试 8: management 槽位 source local')
}

{
  clearEnv()
  process.env.CLOUDFLARE_API_TOKEN = 'env-mgt'
  try {
    const deps = makeDeps()
    const { app } = makeApp(deps)
    const res = await app.request('/api/account/status')
    const data = await res.json()
    check(
      data.tokens.management.source === 'env' && data.tokens.management.hasLocal === true,
      '测试 9: env 优先 → management source env 且 hasLocal true'
    )
  } finally {
    delete process.env.CLOUDFLARE_API_TOKEN
  }
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps, { config: noGatewayConfig })
  const res = await app.request('/api/account/status')
  const data = await res.json()
  check(
    res.status === 200 && data.gateway.accountId === '未配置' && data.gateway.gatewayId === '未配置',
    '测试 10: gateway 未配置 → 未配置文案，不抛错'
  )
}

// ── Token 更新 ───────────────────────────────────────────

section('POST /api/account/update-token')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/update-token', { slot: 'gateway', token: 'cfut-new' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 11: 更新成功 200 ok')
  const u = deps.calls.find((c) => c[0] === 'update')
  check(u && u[1] === 'gateway' && u[2] === 'cfut-new', '测试 11: updateToken 收到 (gateway, cfut-new)')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/update-token', { slot: 'gateway', token: '  ' })
  const data = await res.json()
  check(
    res.status === 200 && data.ok === false && data.skipped === true,
    '测试 12: 空白 token → 200 { ok:false, skipped:true }'
  )
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/update-token', { slot: 'foo', token: 'x' })
  const data = await res.json()
  check(res.status === 400 && data.error.includes('invalid slot'), '测试 13: 非法 slot → 400')
  const res2 = await post(app, '/api/account/update-token', { slot: 'gateway' })
  const data2 = await res2.json()
  check(res2.status === 400 && data2.error.includes('token'), '测试 13: 缺 token 字段 → 400')
}

// ── Token 清除 ───────────────────────────────────────────

section('POST /api/account/clear-token')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/clear-token', { slot: 'management' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true && data.cleared === 'management', '测试 14: cleared management')
  check(data.impact.includes('管理 API Token 已清除'), '测试 14: impact 含管理 Token 文案')
  const c = deps.calls.find((x) => x[0] === 'clear')
  check(c && c[1] === 'management', '测试 14: clearSlotToken 收到 management')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/clear-token', { slot: 'gateway' })
  const data = await res.json()
  check(res.status === 200 && data.cleared === 'gateway', '测试 15: cleared gateway')
  check(data.impact.includes('cfut_xxx'), '测试 15: impact 含 cfut_xxx')
  check(!data.impact.includes('管理 API Token'), '测试 15: 两条文案不同')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/clear-token', { slot: 'foo' })
  const data = await res.json()
  check(res.status === 400 && data.error.includes('invalid slot'), '测试 16: 非法 slot → 400')
}

// ── 初始化向导 ───────────────────────────────────────────

section('POST /api/account/setup')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/account/setup', {})
  const data = await res.json()
  check(res.status === 200 && data.ok === true && data.started === true, '测试 17: started true')
  const s = deps.calls.find((c) => c[0] === 'spawn')
  check(s && s[1] === process.execPath, '测试 17: spawn cmd === process.execPath')
  check(s && s[2].includes('setup'), '测试 17: spawn args 含 setup')
  check(s && s[3].stdio === 'inherit', '测试 17: spawn opts.stdio === inherit')
}

// ── 回归 ─────────────────────────────────────────────────

section('回归：任务 26/28 端点')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps, { state: { 'm1': { status: 'hidden', metadata: {} } } })
  const res = await post(app, '/api/models/toggle', { modelId: 'm1' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true && data.changed === true, '测试 18: 回归 模型 toggle 正常')
  const res2 = await app.request('/api/providers')
  check(res2.status === 200, '测试 18: 回归 GET /api/providers 正常')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
