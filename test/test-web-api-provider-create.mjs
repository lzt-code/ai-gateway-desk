/**
 * 添加 Provider FP2 验证脚本：POST /api/providers/create 端点
 *
 * 覆盖：byok / custom 正常创建（带 pathPrefix 推 KV）、无 pathPrefix 不动 KV、
 * 非 JSON / 非法 type / 缺 id / 非法 slug / 字段类型 / byok 缺 apiKey /
 * custom 缺 baseUrl / baseUrl 非 http(s)、本地与云端查重（拉取失败不阻断）、
 * 无 Token / 缺 gateway 配置、云端创建失败透传（error / reason）、
 * KV 推送失败不回滚。
 *
 * 核心策略：全部依赖 mock（deps 注入 createProviderCloud / fetchCloudProviders /
 * writeProvidersConfigFile / deployProviderRoutesToKV），零触网零写盘；env 变量
 * 先清理，避免 CLOUDFLARE_API_TOKEN 残留影响「无 Token」用例。
 */

import { createApp } from '../src/web/server.js'

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

// 内存 store fixture（与 test-web-api-providers.mjs 一致）
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

const fakeConfig = {
  gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
  kv: { namespaceId: 'ns-1', key: 'models' },
  providers: [
    { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
    { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: true, cloudId: 'abc-123' },
  ],
}

// 云端 provider fixture（与 test-web-api-providers.mjs 一致）
const cloudProviders = [
  { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true, cloudId: 'u1' },
  { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: true, cloudId: 'u2' },
]

// mock deps 工厂：默认云端创建成功 + 云端无重复；选项可注入无 Token / 创建失败 /
// KV 结果 / 覆盖 fetch 结果（查重拉取）
function makeDeps({
  readMgmtToken = 'fake-mgmt-token',
  createResult = {
    ok: true,
    entry: { id: 'newbyok', name: 'New BYOK', type: 'byok', enabled: true, cloudId: 'cu-1' },
  },
  kvResult = { success: true },
  fetchImpl = null,
} = {}) {
  const calls = []
  const createProviderCloud = async (token, accountId, gatewayId, draft) => {
    calls.push(['create', token, draft])
    return createResult
  }
  const fetchCloudProviders = async (...args) => {
    calls.push(['fetch', ...args])
    if (fetchImpl) return fetchImpl(...args)
    return { providers: cloudProviders, errors: [] }
  }
  const writeProvidersConfigFile = (providers) => {
    calls.push(['write', providers])
    return { backupPath: null }
  }
  const deployProviderRoutesToKV = async (payload) => {
    calls.push(['kv', payload])
    return kvResult
  }
  const readManagementToken = () => readMgmtToken
  return {
    calls,
    createProviderCloud,
    fetchCloudProviders,
    writeProvidersConfigFile,
    deployProviderRoutesToKV,
    readManagementToken,
  }
}

// app 工厂：注入 configStore（内存配置）+ stateStore + mock deps
function makeApp(deps, { config = fakeConfig, state = {} } = {}) {
  const store = makeStore(state)
  const app = createApp({
    configStore: { load: () => config },
    stateStore: store,
    deps,
  })
  return { app, store }
}

// env 清理：测试间不残留 CLOUDFLARE_API_TOKEN（进程内共享）
function clearEnv() {
  delete process.env.CLOUDFLARE_API_TOKEN
}

async function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── POST /api/providers/create ───────────────────────────

section('POST /api/providers/create')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', {
    type: 'byok', id: 'newbyok', name: 'New BYOK', apiKey: 'sk-x',
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 1: byok 正常创建 200')
  const create = deps.calls.find((c) => c[0] === 'create')
  check(!!create && create[1] === 'fake-mgmt-token', '测试 1: createProviderCloud 以管理 Token 调用')
  check(!!create && create[2].type === 'byok' && create[2].id === 'newbyok' && create[2].apiKey === 'sk-x', '测试 1: draft 透传 type/id/apiKey')
  check(data.provider && data.provider.id === 'newbyok' && data.provider.name === 'New BYOK' && data.provider.type === 'byok' && data.provider.enabled === true, '测试 1: 响应 provider.id/name/type/enabled 正确')
  check(data.cloudChanged === true && data.localChanged === true, '测试 1: cloudChanged / localChanged 均 true')
  check(data.kvDeployed === true && data.kvSkipped === false && data.kvError === null, '测试 1: 无 pathPrefix 不动 KV，kvDeployed===true')
  const write = deps.calls.find((c) => c[0] === 'write')
  const written = write && write[1].find((p) => p.id === 'newbyok')
  check(!!written && written.cloudId === 'cu-1' && written.enabled === true, '测试 1: 写盘数组含新条目（含 cloudId）')
  check(!deps.calls.some((c) => c[0] === 'kv'), '测试 1: deployProviderRoutesToKV 未被调')
}

{
  clearEnv()
  // custom 带 pathPrefix：落盘 + 推 KV provider-routes
  const deps = makeDeps({
    createResult: { ok: true, entry: { id: 'newcustom', name: 'NewCustom', type: 'custom-provider', enabled: true, cloudId: 'cu-2' } },
  })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', {
    type: 'custom-provider', id: 'newcustom', baseUrl: 'https://api.example.com/v1', pathPrefix: '/v1',
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 2: custom 带 pathPrefix 创建 200')
  const kv = deps.calls.find((c) => c[0] === 'kv')
  check(!!kv, '测试 2: deployProviderRoutesToKV 被调')
  const kvEntry = kv && kv[1].providers.find((p) => p.id === 'newcustom')
  check(!!kvEntry && kvEntry.pathPrefix === '/v1', '测试 2: KV 载荷含新条目 pathPrefix')
  const write = deps.calls.find((c) => c[0] === 'write')
  const written = write && write[1].find((p) => p.id === 'newcustom')
  check(!!written && written.pathPrefix === '/v1', '测试 2: 落盘条目含 pathPrefix')
  check(data.provider && data.provider.pathPrefix === '/v1', '测试 2: 响应 provider 含 pathPrefix')
  check(data.kvDeployed === true && data.kvError === null, '测试 2: KV 推送成功 kvDeployed===true')
}

{
  clearEnv()
  // custom 无 pathPrefix：不动 KV
  const deps = makeDeps({
    createResult: { ok: true, entry: { id: 'newcustom', name: 'NewCustom', type: 'custom-provider', enabled: true, cloudId: 'cu-2' } },
  })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', {
    type: 'custom-provider', id: 'newcustom', baseUrl: 'https://api.example.com/v1',
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 3: 无 pathPrefix 创建 200')
  check(!deps.calls.some((c) => c[0] === 'kv'), '测试 3: deployProviderRoutesToKV 未被调')
  check(data.kvDeployed === true && data.kvSkipped === false, '测试 3: kvDeployed===true / kvSkipped===false')
  const write = deps.calls.find((c) => c[0] === 'write')
  const written = write && write[1].find((p) => p.id === 'newcustom')
  check(!!written && written.pathPrefix === undefined, '测试 3: 落盘条目无 pathPrefix 字段')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const cases = [
    [{}, '缺 type'],
    [{ type: 'custom' }, '非法 type'],
    [{ type: 'byok', apiKey: 'sk-x' }, '缺 id'],
    [{ type: 'byok', id: 'Bad_Slug', apiKey: 'sk-x' }, '非法 slug（大写/下划线）'],
  ]
  for (const [body, label] of cases) {
    const res = await post(app, '/api/providers/create', body)
    const data = await res.json()
    check(res.status === 400, `测试 4: ${label} → 400`)
    check(typeof data.error === 'string' && data.error.length > 0, `测试 4: ${label} → 有 error 文案`)
  }
  // 非 JSON body → 400 invalid json body
  const res = await app.request('/api/providers/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  })
  const data = await res.json()
  check(res.status === 400 && data.error === 'invalid json body', '测试 4: 非 JSON body → 400 invalid json body')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 4: 校验失败 createProviderCloud 未被调')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok' })
  const data = await res.json()
  check(res.status === 400, '测试 5: byok 缺 apiKey → 400')
  check(typeof data.error === 'string' && data.error.includes('apiKey'), '测试 5: 文案提及 apiKey')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 5: createProviderCloud 未被调')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const missing = await post(app, '/api/providers/create', { type: 'custom-provider', id: 'newcustom' })
  const mData = await missing.json()
  check(missing.status === 400, '测试 6: custom 缺 baseUrl → 400')
  check(typeof mData.error === 'string' && mData.error.includes('baseUrl'), '测试 6: 文案提及 baseUrl')
  const bad = await post(app, '/api/providers/create', { type: 'custom-provider', id: 'newcustom', baseUrl: 'ftp://x' })
  const bData = await bad.json()
  check(bad.status === 400, '测试 6: baseUrl 非 http(s) → 400')
  check(typeof bData.error === 'string' && bData.error.includes('baseUrl'), '测试 6: 文案提及 baseUrl')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 6: createProviderCloud 未被调')
}

{
  clearEnv()
  // 本地已有同 id（fakeConfig.providers 含 openrouter）→ 400，不触云端
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'openrouter', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 400 && data.error === "provider 'openrouter' 已存在", '测试 7: 本地已有同 id → 400')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 7: createProviderCloud 未被调')
}

{
  clearEnv()
  // 云端已有同 id（本地无）→ 400
  const deps = makeDeps({
    fetchImpl: async () => ({
      providers: [...cloudProviders, { id: 'newbyok', name: 'New BYOK', type: 'byok', enabled: true, cloudId: 'cu-x' }],
      errors: [],
    }),
  })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 400 && data.error === "provider 'newbyok' 已存在", '测试 8: 云端已有同 id → 400')
  check(deps.calls.some((c) => c[0] === 'fetch'), '测试 8: fetchCloudProviders 被调')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 8: createProviderCloud 未被调')
}

{
  clearEnv()
  // 云端查重拉取失败 → 忽略不阻断创建
  const deps = makeDeps({ fetchImpl: async () => { throw new Error('云端不可达') } })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 8b: 云端查重拉取失败不阻断创建')
  check(deps.calls.some((c) => c[0] === 'create'), '测试 8b: createProviderCloud 被调')
}

{
  clearEnv()
  const deps = makeDeps({ readMgmtToken: null })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 400 && data.error === 'management token not configured', '测试 9: 无管理 Token → 400')
  check(!deps.calls.some((c) => c[0] === 'fetch' || c[0] === 'create' || c[0] === 'write'), '测试 9: fetch / create / write 均未被调')
}

{
  clearEnv()
  // 缺 gateway.accountId（byok 还缺 gatewayId）→ 400
  const config = { ...fakeConfig, gateway: { host: 'gateway.ai.cloudflare.com', gatewayId: 'gw' } }
  const deps = makeDeps()
  const { app } = makeApp(deps, { config })
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 400 && data.error === 'gateway config not initialized', '测试 10: 缺 gateway.accountId → 400')
  check(!deps.calls.some((c) => c[0] === 'create'), '测试 10: createProviderCloud 未被调')
}

{
  clearEnv()
  // error 形态：400 透传 error.message，不写盘
  const deps = makeDeps({ createResult: { ok: false, error: new Error('云端 500') } })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data = await res.json()
  check(res.status === 400 && data.error === '云端 500', '测试 11: 云端创建失败（error）→ 400 透传')
  check(!deps.calls.some((c) => c[0] === 'write'), '测试 11: 失败不写盘')

  // reason 形态：400 透传 reason（校验失败未触网）
  clearEnv()
  const deps2 = makeDeps({ createResult: { ok: false, reason: '类型必须是 byok 或 custom-provider' } })
  const { app: app2 } = makeApp(deps2)
  const res2 = await post(app2, '/api/providers/create', { type: 'byok', id: 'newbyok', apiKey: 'sk-x' })
  const data2 = await res2.json()
  check(res2.status === 400 && data2.error === '类型必须是 byok 或 custom-provider', '测试 11b: 云端创建失败（reason）→ 400 透传 reason')
}

{
  clearEnv()
  // KV 推送失败 → 仍 200（不回滚，与 update 语义一致），kvDeployed===false，kvError 非空
  const deps = makeDeps({
    createResult: { ok: true, entry: { id: 'newcustom', name: 'NewCustom', type: 'custom-provider', enabled: true, cloudId: 'cu-2' } },
    kvResult: { success: false, output: 'KV 500' },
  })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/create', {
    type: 'custom-provider', id: 'newcustom', baseUrl: 'https://api.example.com/v1', pathPrefix: '/v1',
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 12: KV 推送失败仍 200（不回滚）')
  check(data.kvDeployed === false && data.kvError === 'KV 500', '测试 12: kvDeployed===false / kvError 非空')
  check(data.kvSkipped === false, '测试 12: kvSkipped===false')
  const write = deps.calls.find((c) => c[0] === 'write')
  check(write && write[1].some((p) => p.id === 'newcustom'), '测试 12: 已写盘（本地不回滚）')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)