/**
 * 任务 28 验证脚本：Provider 管理 API 端点
 *
 * 覆盖：GET /api/providers（正常合并 / 云端新增 new / 本地独有 removed / 无 Token
 * 只读 / 拉取失败降级 / 云端不完整不标 removed）、POST /api/providers/refresh
 * （与 GET 等价）、POST /api/providers/update（Custom 改名 / 仅本地开关 / BYOK 改名
 * 无 Key unsupported / Custom 传 Key unsupported / 云端失败 / 无 Token / 不存在 /
 * 缺 changes）、POST /api/providers/delete（正常 / 云端已删仅本地 / 缺 cloudId /
 * 无 Token / 不存在）、写盘内容断言、任务 26 回归。
 *
 * 核心策略：全部依赖 mock（deps 注入），零触网零写盘；env 变量先清理，
 * 需要时显式设置并恢复。
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

// 内存 store fixture（与 test-web-api-models.mjs 一致）
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

// 云端 provider fixture（交付包 mock 工厂）
const cloudProviders = [
  { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true, cloudId: 'u1' },
  { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: true, cloudId: 'u2' },
]

// mock deps 工厂：默认云端两源成功；选项可注入无 Token / 失败 / 覆盖 fetch 结果
function makeDeps({
  readMgmtToken = 'fake-mgmt-token',
  updateResult = { ok: true, result: {} },
  deleteResult = { ok: true, result: null },
  fetchImpl = null,
} = {}) {
  const calls = []
  const kvWrites = []
  let visibilityMap = {}
  const fetchCloudProviders = async (...args) => {
    calls.push(['fetch', ...args])
    if (fetchImpl) return fetchImpl(...args)
    // 排除已删除的 provider（模拟真实 API 删除后列表更新）
    const deletedIds = calls.filter((c) => c[0] === 'delete').map((c) => c[1])
    return { providers: cloudProviders.filter((p) => !deletedIds.includes(p.id)), errors: [] }
  }
  const updateProviderCloud = async (token, accountId, gatewayId, provider, changes) => {
    calls.push(['update', provider.id, changes])
    return updateResult
  }
  const deleteProviderCloud = async (token, accountId, gatewayId, provider) => {
    calls.push(['delete', provider.id])
    return deleteResult
  }
  const writeProvidersConfigFile = (providers) => {
    calls.push(['write', providers])
    return { backupPath: null }
  }
  const readManagementToken = () => readMgmtToken
  const readKvVisibility = async () => visibilityMap
  const writeKvVisibility = async (token, accountId, namespaceId, map) => {
    visibilityMap = { ...map }
    kvWrites.push(map)
  }
  return {
    calls,
    kvWrites,
    fetchCloudProviders,
    updateProviderCloud,
    deleteProviderCloud,
    writeProvidersConfigFile,
    readManagementToken,
    readKvVisibility,
    writeKvVisibility,
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

// ── GET /api/providers ───────────────────────────────────

section('GET /api/providers')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  check(res.status === 200, '测试 1: 状态码 200')
  check(data.ok === true, '测试 1: ok===true')
  check(data.readonly === false, '测试 1: 有 Token 非只读')
  check(Array.isArray(data.providers) && data.providers.length === 2, '测试 1: providers 含云端 2 条')
  check(data.providers.every((p) => p.mark === null), '测试 1: 两边都有 mark 全 null')
  check(deps.calls.some((c) => c[0] === 'fetch'), '测试 1: fetchCloudProviders 被调')
  check(data.sourceCounts && data.sourceCounts.custom === 1 && data.sourceCounts.byok === 1, '测试 1: sourceCounts 统计 Custom 1 / BYOK 1')
  check(Array.isArray(data.cloudErrors) && data.cloudErrors.length === 0, '测试 1: 两源成功 cloudErrors 为空')
  check(data.degradedReason === '', '测试 1: 非降级 degradedReason 为空')
}

{
  clearEnv()
  const deps = makeDeps({
    fetchImpl: async () => ({
      providers: [...cloudProviders, { id: 'deepseek', name: 'DeepSeek', type: 'byok', enabled: true, cloudId: 'u3' }],
      errors: [],
    }),
  })
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  const deepseek = data.providers.find((p) => p.id === 'deepseek')
  check(res.status === 200 && deepseek, '测试 2: 200 且含 deepseek')
  check(deepseek && deepseek.mark === 'new', '测试 2: 云端新增标 new')
}

{
  clearEnv()
  const config = {
    ...fakeConfig,
    providers: [...fakeConfig.providers, { id: 'sensenova', name: 'SenseNova', type: 'byok', enabled: true }],
  }
  const deps = makeDeps() // 云端无 sensenova
  const { app } = makeApp(deps, { config })
  const res = await app.request('/api/providers')
  const data = await res.json()
  const sensenova = data.providers.find((p) => p.id === 'sensenova')
  check(res.status === 200 && sensenova, '测试 3: 200 且含 sensenova')
  check(sensenova && sensenova.mark === 'removed', '测试 3: 本地独有标 removed')
}

{
  clearEnv()
  const deps = makeDeps({ readMgmtToken: null })
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  check(res.status === 200 && data.readonly === true, '测试 4: 无 Token 只读 readonly===true')
  check(data.providers.length === 2 && data.providers.every((p) => p.mark === null), '测试 4: providers 只含本地且 mark 全 null')
  check(!deps.calls.some((c) => c[0] === 'fetch'), '测试 4: fetch 未被调')
  check(data.degradedReason === 'no-token', '测试 4: degradedReason=no-token')
  check(data.sourceCounts && data.sourceCounts.custom === 1 && data.sourceCounts.byok === 1, '测试 4: sourceCounts 按本地缓存统计（Custom 1 / BYOK 1）')
}

{
  clearEnv()
  const deps = makeDeps({
    fetchImpl: async () => {
      throw new Error('云端不可达')
    },
  })
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  check(res.status === 200 && data.readonly === true, '测试 5: 拉取失败降级 readonly===true')
  check(data.providers.length === 2, '测试 5: providers 为本地缓存')
  check(data.degradedReason === 'fetch-failed', '测试 5: degradedReason=fetch-failed')
  check(data.cloudErrors.length === 1 && data.cloudErrors[0].source === 'cloud' && data.cloudErrors[0].message === '云端不可达', '测试 5: cloudErrors 透传云端错误 message')
}

{
  clearEnv()
  const deps = makeDeps({
    fetchImpl: async () => ({
      providers: [cloudProviders[0]], // 只有 agnes
      errors: [{ source: 'provider_configs', error: new Error('byok 拉取失败') }],
    }),
  })
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  check(res.status === 200 && data.readonly === false, '测试 6: 不完整拉取非只读')
  // mergeProviderViews 抑制 removed：本地独有的 openrouter 不进入视图，且无任何条目被标 removed
  check(data.providers.every((p) => p.mark !== 'removed'), '测试 6: 云端不完整不标 removed')
  check(!data.providers.some((p) => p.id === 'openrouter' && p.mark === 'removed'), '测试 6: openrouter 未被误标 removed')
  check(data.sourceCounts && data.sourceCounts.custom === 1 && data.sourceCounts.byok === 0, '测试 6: sourceCounts 按实际拉到的源统计')
  check(data.cloudErrors.length === 1 && data.cloudErrors[0].source === 'provider_configs' && data.cloudErrors[0].message === 'byok 拉取失败', '测试 6: cloudErrors 含源失败 message（Error 已转字符串）')
}

{
  clearEnv()
  // KV 可见性覆盖：本地 agnes.enabled=true，但 KV 标记 agnes=false → 展示隐藏 + 回写本地
  let writtenProviders = null
  const deps = makeDeps()
  deps.readKvVisibility = async () => ({ agnes: false })
  deps.writeProvidersConfigFile = (providers) => { writtenProviders = providers; return { backupPath: null } }
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  const agnes = data.providers.find((p) => p.id === 'agnes')
  check(res.status === 200, 'KV 覆盖: 200')
  check(agnes && agnes.enabled === false, 'KV 覆盖: agnes.enabled===false（展示隐藏）')
  check(writtenProviders && writtenProviders.find((p) => p.id === 'agnes').enabled === false,
    'KV 覆盖: 本地 providers.json 被回写为 agnes.enabled=false')
}

{
  clearEnv()
  // KV 读取失败 → 静默降级，用本地 enabled（不抛 500）
  const deps = makeDeps()
  deps.readKvVisibility = async () => { throw new Error('KV 403') }
  const { app } = makeApp(deps)
  const res = await app.request('/api/providers')
  const data = await res.json()
  check(res.status === 200, 'KV 失败: 仍 200（降级本地）')
  const kvErr = (data.cloudErrors || []).find((e) => e.source === 'kv-visibility')
  check(!!kvErr && kvErr.message.includes('403'), 'KV 失败: cloudErrors 含 kv-visibility 源')
  check(data.providers.every((p) => p.enabled === true), 'KV 失败: 本地 enabled 原样（true）')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/refresh', {})
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 7: refresh 返回 200 ok')
  check(data.readonly === false && data.providers.length === 2, '测试 7: 响应结构与 GET 一致')
}

// ── POST /api/providers/update ───────────────────────────

section('POST /api/providers/update')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { name: 'Agnes 2' },
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 8: Custom 改名 200')
  const upd = deps.calls.find((c) => c[0] === 'update')
  check(upd && upd[1] === 'agnes', '测试 8: updateProviderCloud 以 agnes 调用')
  check(upd && upd[2].name === 'Agnes 2' && upd[2].cloudEnabled === undefined, '测试 8: 云端 changes 仅含 name（无 cloudEnabled）')
  check(data.cloudChanged === true, '测试 8: cloudChanged===true')
  check(data.provider && data.provider.name === 'Agnes 2', '测试 8: 响应 provider.name 已更新')
}

{
  clearEnv()
  // 可见性切换（隐藏）：写本地 + 写 KV provider-visibility
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { localEnabled: false },
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 9: 隐藏开关 200')
  check(data.cloudChanged === false && data.localChanged === true, '测试 9: cloudChanged false / localChanged true')
  check(!deps.calls.some((c) => c[0] === 'update'), '测试 9: 云端 update 未被调')
  check(deps.kvWrites.length === 1, '测试 9: KV provider-visibility 被写 1 次')
  check(deps.kvWrites[0].agnes === false, '测试 9: KV map 含 agnes=false')
  const write = deps.calls.find((c) => c[0] === 'write')
  const writtenAgnes = write && write[1].find((p) => p.id === 'agnes')
  check(writtenAgnes && writtenAgnes.enabled === false, '测试 9: 写盘含 agnes.enabled===false')
}

{
  clearEnv()
  // 无管理 Token：可见性切换需写 KV → 400
  const deps = makeDeps({ readMgmtToken: null })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { localEnabled: false },
  })
  const data = await res.json()
  check(res.status === 400 && data.error === 'management token not configured', '测试 9b: 无 Token 切换可见性 → 400')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'openrouter',
    changes: { name: '新名' },
  })
  const data = await res.json()
  check(res.status === 400, '测试 10: BYOK 改名无 Key → 400')
  check(typeof data.error === 'string' && data.error.includes('同时提供新 Key'), '测试 10: unsupported 文案透传')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { apiKey: 'sk-x' },
  })
  const data = await res.json()
  check(res.status === 200, '测试 11: Custom 传 Key → 200')
  check(data.ok === true, '测试 11: ok = true')
}

{
  clearEnv()
  // Custom 改 baseUrl → 云端变更（changes 含 baseUrl 透传）
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { baseUrl: 'https://new.example.com' },
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '测试 11b: Custom 改 baseUrl → 200')
  const upd = deps.calls.find((c) => c[0] === 'update')
  check(upd && upd[2] && upd[2].baseUrl === 'https://new.example.com', '测试 11b: updateProviderCloud changes 含 baseUrl')
  check(data.cloudChanged === true, '测试 11b: cloudChanged===true')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { baseUrl: 'ftp://bad' },
  })
  const data = await res.json()
  check(res.status === 400 && typeof data.error === 'string' && data.error.includes('baseUrl'), '测试 11c: baseUrl 非 http(s) → 400')
  check(!deps.calls.some((c) => c[0] === 'update'), '测试 11c: 云端 update 未被调')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'openrouter',
    changes: { baseUrl: 'https://x.com' },
  })
  const data = await res.json()
  check(res.status === 400 && typeof data.error === 'string' && data.error.includes('Base URL'), '测试 11d: BYOK 改 baseUrl → 400（unsupported 文案）')
}

{
  clearEnv()
  const deps = makeDeps({ updateResult: { ok: false, error: new Error('云端 500') } })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { name: 'Agnes 2' },
  })
  const data = await res.json()
  check(res.status === 400 && data.error === '云端 500', '测试 12: 云端调用失败 400 透传错误')
}

{
  clearEnv()
  const deps = makeDeps({ readMgmtToken: null })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', {
    id: 'agnes',
    changes: { name: 'Agnes 2' },
  })
  const data = await res.json()
  check(res.status === 400 && data.error === 'management token not configured', '测试 13: 无 Token 云端变更 → 400')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', { id: 'nope', changes: {} })
  const data = await res.json()
  check(res.status === 404 && data.error === 'provider not found', '测试 14: provider 不存在 → 404')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/update', { id: 'agnes' })
  const data = await res.json()
  check(res.status === 400 && typeof data.error === 'string' && data.error.includes('changes'), '测试 15: 缺 changes → 400')
}

// ── POST /api/providers/delete ───────────────────────────

section('POST /api/providers/delete')

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/delete', { id: 'openrouter' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true && data.removed === true, '测试 16: 正常删除 200 removed:true')
  check(deps.calls.some((c) => c[0] === 'delete' && c[1] === 'openrouter'), '测试 16: deleteProviderCloud 被调')
  const write = deps.calls.find((c) => c[0] === 'write')
  check(write && !write[1].some((p) => p.id === 'openrouter'), '测试 16: 写盘已无 openrouter')
}

{
  clearEnv()
  // 本地含 sensenova（无 cloudId，云端已删场景）；云端不含它
  const config = {
    ...fakeConfig,
    providers: [...fakeConfig.providers, { id: 'sensenova', name: 'SenseNova', type: 'byok', enabled: true }],
  }
  const deps = makeDeps()
  const { app } = makeApp(deps, { config })
  const res = await post(app, '/api/providers/delete', { id: 'sensenova' })
  const data = await res.json()
  check(res.status === 200 && data.removed === true, '测试 17: 云端已删条目仅本地移除 200')
  check(!deps.calls.some((c) => c[0] === 'delete'), '测试 17: deleteProviderCloud 未被调')
  const write = deps.calls.find((c) => c[0] === 'write')
  check(write && !write[1].some((p) => p.id === 'sensenova'), '测试 17: 写盘已无 sensenova')
}

{
  clearEnv()
  // agnes 本地无 cloudId 但云端存在 → 400 提示刷新
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/delete', { id: 'agnes' })
  const data = await res.json()
  check(res.status === 400, '测试 18: 缺 cloudId（云端存在）→ 400')
  check(typeof data.error === 'string' && data.error.includes('cloudId'), '测试 18: 错误文案含 cloudId')
}

{
  clearEnv()
  const deps = makeDeps({ readMgmtToken: null })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/delete', { id: 'openrouter' })
  const data = await res.json()
  check(res.status === 400 && data.error === 'management token not configured', '测试 19: 无 Token → 400')
}

{
  clearEnv()
  const deps = makeDeps()
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/delete', { id: 'nope' })
  const data = await res.json()
  // 幂等删除：provider 不存在 → 视为成功（避免前端缓存过期时报错）
  check(res.status === 200 && data.ok === true && data.removed === true, '测试 20: 不存在 → 幂等成功 200')
}

// 云端返回 404 → 尝试删除失败但视为「云端已删」，继续仅本地移除
{
  clearEnv()
  class MockCloudflareError extends Error {
    constructor(status, message) {
      super(message)
      this.status = status
    }
  }
  const deps = makeDeps({
    deleteResult: { ok: false, error: new MockCloudflareError(404, 'HTTP 404') },
  })
  const { app } = makeApp(deps)
  const res = await post(app, '/api/providers/delete', { id: 'openrouter' })
  const data = await res.json()
  check(res.status === 200 && data.removed === true, '测试 21: 云端 404 → 仅本地移除 200')
  // 云端 404 时仍会尝试调用 deleteProviderCloud，但成功后继续本地移除
  check(deps.calls.some((c) => c[0] === 'delete' && c[1] === 'openrouter'), '测试 21: 云端 404 仍尝试删除（失败后降级）')
  const write = deps.calls.find((c) => c[0] === 'write')
  check(write && !write[1].some((p) => p.id === 'openrouter'), '测试 21: 写盘已无 openrouter')
}

// ── 写盘内容断言 + 回归 ──────────────────────────────────

section('写盘内容 + 回归')

{
  clearEnv()
  // update：可见性切换后写盘数组与 config.providers 内容一致（深比较 enabled）
  const deps = makeDeps()
  const { app } = makeApp(deps)
  await post(app, '/api/providers/update', { id: 'agnes', changes: { localEnabled: false } })
  const write = deps.calls.find((c) => c[0] === 'write')
  const agnes = write && write[1].find((p) => p.id === 'agnes')
  const openrouter = write && write[1].find((p) => p.id === 'openrouter')
  check(agnes && agnes.enabled === false, '写盘数组含改后的 agnes.enabled===false')
  check(openrouter && openrouter.cloudId === 'abc-123', '写盘数组保留未改条目原字段')
  check(deps.kvWrites.length === 1 && deps.kvWrites[0].agnes === false, '同时写 KV provider-visibility')
}

{
  clearEnv()
  // 回归：任务 26 模型 API 不受影响
  const deps = makeDeps()
  const { app } = makeApp(deps, { state: { 'm1': { status: 'hidden', metadata: {} } } })
  const res = await post(app, '/api/models/toggle', { modelId: 'm1' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true && data.changed === true, '测试 22: 回归 模型 toggle 正常')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
