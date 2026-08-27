/**
 * 任务 27 验证脚本：同步 + 保存部署 API 端点
 *
 * 覆盖：POST /api/sync（编排顺序/落盘/provider 同步失败不中断/discover 抛错 500/
 * 无结果/并发 409/缺 token 400/env 优先）、SSE /api/sync/progress（事件序列/data
 * 无 type/error 后关闭）、POST /api/save-deploy（成功/失败透传）、POST /api/save
 * （仅两步）、runSyncFlow 纯函数（不经 HTTP，含 enrich 失败静默）、任务 26 回归。
 *
 * 核心策略：全部依赖 mock（deps 注入），零触网零写盘；env 变量先清理，
 * 需要时显式设置并恢复。
 */

import { createApp } from '../src/web/server.js'
import { runSyncFlow } from '../src/web/sync-flow.js'
import { setDebugFlag } from '../src/core/config.js'

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

// mock 配置（不读真实 data/ 文件）
const fakeConfig = {
  gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
  providers: [{ id: 'custom-agnes', type: 'custom-provider', enabled: true }],
}

// mock deps 工厂（默认全部成功；选项可注入失败/无结果/gate 场景）
function makeDeps({
  discoverFail = false,
  syncFail = false,
  enrichFail = false,
  noResults = false,
  gate = null,
  readTokenVal = 'fake-gateway-token',
  saveDeployResult = { ok: true },
  syncNew = [],
  syncRemoved = [],
  syncErrors = [],
} = {}) {
  const calls = []
  const tokens = []
  const discoverFilters = []
  const discoverModels = async (config, token, onProgress, providerFilter) => {
    calls.push('discover')
    tokens.push(token)
    discoverFilters.push(providerFilter ?? null)
    if (gate) await gate
    onProgress?.({ provider: 'custom-agnes', status: 'pending', done: 0, total: 1 })
    if (discoverFail) throw new Error('discover 网络错误')
    if (noResults) return { results: [], errors: [] }
    onProgress?.({ provider: 'custom-agnes', status: 'done', models: 2, done: 1, total: 1 })
    return {
      results: [
        {
          provider: 'custom-agnes',
          models: [
            { id: 'custom-agnes/agnes', name: 'Agnes' },
            { id: 'custom-agnes/agnes2', name: 'Agnes 2' },
          ],
        },
      ],
      errors: [],
    }
  }
  const mergeDiscovery = (state, d) => ({
    state: {
      ...structuredClone(state),
      'custom-agnes/agnes': { status: 'selected', metadata: {} },
    },
    newModels: ['custom-agnes/agnes'],
    updatedModels: [],
    removedModels: [],
  })
  const enrichModel = async (id, meta) => {
    calls.push('enrich')
    if (enrichFail) throw new Error('enrich 失败')
    return { ...meta, name: id }
  }
  const syncProvidersToConfig = async () => {
    calls.push('provider-sync')
    if (syncFail) return { ok: false, error: new Error('云端失败') }
    return {
      ok: true,
      result: {
        providers: [],
        newProviders: syncNew,
        removedProviders: syncRemoved,
        errors: syncErrors,
      },
    }
  }
  const saveAndDeploy = async (args) => {
    calls.push('saveAndDeploy')
    saveAndDeployArgs = args
    return saveDeployResult
  }
  const writeModelsJson = async () => {
    calls.push('write-models-json')
  }
  const readToken = () => readTokenVal
  const readManagementToken = () => 'fake-mgmt-token'
  let saveAndDeployArgs = null
  return {
    calls,
    tokens,
    discoverFilters,
    get saveAndDeployArgs() {
      return saveAndDeployArgs
    },
    discoverModels,
    mergeDiscovery,
    enrichModel,
    syncProvidersToConfig,
    saveAndDeploy,
    writeModelsJson,
    readToken,
    readManagementToken,
  }
}

// 注入内存 store + mock deps 的 app
function makeApp(initial = {}, depsOpts = {}) {
  const store = makeStore(initial)
  const deps = makeDeps(depsOpts)
  const app = createApp({
    stateStore: store,
    configStore: { load: () => fakeConfig },
    deps,
  })
  return { app, store, deps }
}

// 解析 SSE 响应文本 → 事件数组 [{ type, data }]
// 注意事件名可能含连字符（如 provider-sync），不能用 \w+ 匹配
function parseSseEvents(text) {
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const m = block.match(/^event: ([\w-]+)\ndata: (.*)$/m)
      return m ? { type: m[1], data: JSON.parse(m[2]) } : null
    })
    .filter(Boolean)
}

// env 清理/恢复（防止本机真实 GATEWAY_TOKEN 污染测试）
function withCleanEnv() {
  const saved = {}
  for (const k of ['GATEWAY_TOKEN', 'CLOUDFLARE_API_TOKEN']) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// ── 测试 1：sync 全流程（编排顺序 + 汇总）──
section('测试 1: POST /api/sync 全流程')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app, deps } = makeApp()
    const res = await app.request('/api/sync', { method: 'POST' })
    const body = await res.json()
    check(res.status === 200, 'HTTP 200')
    check(body.ok === true, 'ok === true')
    check(
      Array.isArray(body.summary.newModels) && body.summary.newModels.length === 1,
      'summary.newModels 数量正确'
    )
    check(Array.isArray(body.summary.errors), 'summary.errors 为数组')
    const idx = (x) => deps.calls.indexOf(x)
    check(
      idx('provider-sync') >= 0 && idx('provider-sync') < idx('discover') && idx('discover') < idx('enrich'),
      '调用顺序 provider-sync → discover → enrich'
    )
    check(deps.tokens[0] === 'fake-gateway-token', 'discoverModels 收到 gateway token')
  } finally {
    restoreEnv()
  }
}

// ── 测试 2：sync 后 state 落盘（仅一次）──
section('测试 2: sync 后 state 落盘')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app, store } = makeApp()
    const res = await app.request('/api/sync', { method: 'POST' })
    check(res.status === 200, 'HTTP 200')
    check(store.saves.length === 1, 'save 恰好调用 1 次')
    check(
      store.saves[0] && store.saves[0]['custom-agnes/agnes'] !== undefined,
      '落盘 state 含新模型'
    )
  } finally {
    restoreEnv()
  }
}

// ── 测试 3：provider 同步失败不中断 discover（SSE provider-sync 事件 ok:false）──
section('测试 3: provider 同步失败不中断')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp({}, { syncFail: true })
    const ssePromise = app.request('/api/sync/progress')
    const postRes = await app.request('/api/sync', { method: 'POST' })
    const postBody = await postRes.json()
    check(postRes.status === 200 && postBody.ok === true, '同步仍成功（HTTP 200）')
    const sseRes = await ssePromise
    const events = parseSseEvents(await sseRes.text())
    const psEv = events.find((e) => e.type === 'provider-sync')
    check(!!psEv && psEv.data.ok === false, 'provider-sync 事件 ok:false')
    check(events.some((e) => e.type === 'discover'), 'discover 仍执行')
  } finally {
    restoreEnv()
  }
}

// ── 测试 3b：provider 同步成功事件携带新增/移除/错误明细 ──
section('测试 3b: provider-sync 成功事件带明细')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp({}, {
      syncNew: ['deepseek', 'moonshot'],
      syncRemoved: ['sensenova'],
      // Error 实例：SSE 序列化后必须转为可读 message 字符串
      syncErrors: [{ source: 'provider_configs', error: new Error('byok 403') }],
    })
    const ssePromise = app.request('/api/sync/progress')
    const postRes = await app.request('/api/sync', { method: 'POST' })
    check(postRes.status === 200, '同步 HTTP 200')
    const sseRes = await ssePromise
    const events = parseSseEvents(await sseRes.text())
    const psEv = events.find((e) => e.type === 'provider-sync')
    check(!!psEv && psEv.data.ok === true, 'provider-sync 事件 ok:true')
    check(
      psEv && JSON.stringify(psEv.data.newProviders) === JSON.stringify(['deepseek', 'moonshot']),
      '事件携带 newProviders 明细'
    )
    check(
      psEv && JSON.stringify(psEv.data.removedProviders) === JSON.stringify(['sensenova']),
      '事件携带 removedProviders 明细'
    )
    check(
      psEv && psEv.data.errors.length === 1
        && psEv.data.errors[0].source === 'provider_configs'
        && psEv.data.errors[0].message === 'byok 403',
      '事件 errors 的 Error 已转为 message 字符串'
    )
  } finally {
    restoreEnv()
  }
}

// ── 测试 4：discover 抛错 → 500 ──
section('测试 4: discover 抛错 → 500')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp({}, { discoverFail: true })
    const res = await app.request('/api/sync', { method: 'POST' })
    const body = await res.json()
    check(res.status === 500, 'HTTP 500')
    check((body.error || '').includes('discover 网络错误'), '错误信息透出')
  } finally {
    restoreEnv()
  }
}

// ── 测试 5：discover 无结果（不抛错，不调 merge/enrich）──
section('测试 5: discover 无结果')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app, deps } = makeApp({}, { noResults: true })
    const res = await app.request('/api/sync', { method: 'POST' })
    const body = await res.json()
    check(res.status === 200 && body.ok === true, 'HTTP 200')
    check(
      body.summary.newModels.length === 0 &&
        body.summary.updatedModels.length === 0 &&
        body.summary.removedModels.length === 0,
      'summary 全空'
    )
    check(!deps.calls.includes('enrich'), '未调用 enrich')
  } finally {
    restoreEnv()
  }
}

// ── 测试 6：并发 POST /api/sync → 409 ──
section('测试 6: 并发 409')
{
  const restoreEnv = withCleanEnv()
  try {
    let releaseGate
    const gate = new Promise((r) => {
      releaseGate = r
    })
    const { app } = makeApp({}, { gate })
    const p1 = app.request('/api/sync', { method: 'POST' })
    // 确保 p1 的 handler 已进入 syncing（gate 使其挂起）
    await new Promise((r) => setImmediate(r))
    const res2 = await app.request('/api/sync', { method: 'POST' })
    const body2 = await res2.json()
    check(res2.status === 409, '第二次 POST → 409')
    check(body2.error === 'sync already in progress', '409 错误文案正确')
    releaseGate()
    const res1 = await p1
    check(res1.status === 200, '第一次 POST 最终 200')
  } finally {
    restoreEnv()
  }
}

// ── 测试 7：无 gateway token → 400 ──
section('测试 7: 无 gateway token → 400')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp({}, { readTokenVal: null })
    const res = await app.request('/api/sync', { method: 'POST' })
    const body = await res.json()
    check(res.status === 400, 'HTTP 400')
    check((body.error || '').includes('gateway token'), '错误文案含 gateway token')
  } finally {
    restoreEnv()
  }
}

// ── 测试 8：env 优先于本地槽位 ──
section('测试 8: env GATEWAY_TOKEN 优先')
{
  const restoreEnv = withCleanEnv()
  try {
    process.env.GATEWAY_TOKEN = 'env-token'
    const { app, deps } = makeApp({}, { readTokenVal: 'local-token' })
    const res = await app.request('/api/sync', { method: 'POST' })
    check(res.status === 200, 'HTTP 200')
    check(deps.tokens[0] === 'env-token', 'discoverModels 收到 env token（优先于本地）')
  } finally {
    restoreEnv()
  }
}

// ── 测试 9：SSE 完整事件序列 + done 汇总一致 ──
section('测试 9: SSE 完整事件序列')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp()
    const ssePromise = app.request('/api/sync/progress')
    const postRes = await app.request('/api/sync', { method: 'POST' })
    const postBody = await postRes.json()
    check(postRes.status === 200, 'POST /api/sync 200')
    const sseRes = await ssePromise
    check(sseRes.status === 200, 'SSE HTTP 200')
    const contentType = sseRes.headers.get('content-type') || ''
    check(contentType.includes('text/event-stream'), 'SSE content-type 为 text/event-stream')
    const events = parseSseEvents(await sseRes.text())
    const types = events.map((e) => e.type)
    // 必需事件按序出现（子序列检查）
    const required = ['phase', 'provider-sync', 'phase', 'discover', 'phase', 'enrich', 'done']
    let i = 0
    for (const t of types) {
      if (t === required[i]) i++
    }
    check(i === required.length, `事件序列包含全部必需事件（实际: ${types.join(',')}）`)
    const doneEv = events.find((e) => e.type === 'done')
    check(
      !!doneEv && JSON.stringify(doneEv.data.summary) === JSON.stringify(postBody.summary),
      'done 事件 summary 与 POST 响应一致'
    )
  } finally {
    restoreEnv()
  }
}

// ── 测试 10：SSE 事件 data 无 type 字段 ──
section('测试 10: SSE data 无 type 字段')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp()
    const ssePromise = app.request('/api/sync/progress')
    await app.request('/api/sync', { method: 'POST' })
    const sseRes = await ssePromise
    const events = parseSseEvents(await sseRes.text())
    check(events.length > 0, '收到事件')
    check(events.every((e) => !('type' in e.data)), '所有事件 data 均无 type 键')
  } finally {
    restoreEnv()
  }
}

// ── 测试 11：SSE error 事件后流结束 ──
section('测试 11: SSE error 事件')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp({}, { discoverFail: true })
    const ssePromise = app.request('/api/sync/progress')
    const postRes = await app.request('/api/sync', { method: 'POST' })
    check(postRes.status === 500, 'POST 500')
    const sseRes = await ssePromise
    const events = parseSseEvents(await sseRes.text())
    const errorEv = events.find((e) => e.type === 'error')
    check(!!errorEv, '收到 error 事件')
    check((errorEv.data.message || '').includes('discover 网络错误'), 'error 消息正确')
    check(events[events.length - 1].type === 'error', 'error 为最后一个事件（流已关闭）')
  } finally {
    restoreEnv()
  }
}

// ── 测试 12：save-deploy 成功 ──
section('测试 12: POST /api/save-deploy 成功')
{
  const { app, deps, store } = makeApp()
  const res = await app.request('/api/save-deploy', { method: 'POST' })
  const body = await res.json()
  check(res.status === 200 && body.ok === true, 'HTTP 200 { ok: true }')
  check(deps.calls.filter((c) => c === 'saveAndDeploy').length === 1, 'saveAndDeploy 恰好调用 1 次')
  const args = deps.saveAndDeployArgs
  check(!!args && args.config === fakeConfig, '收到 { state, config }')
  check(!!args && args.state === store.state, 'state 为当前内存态')
}

// ── 测试 13：save-deploy 失败透传（HTTP 200 + { ok:false }）──
section('测试 13: save-deploy 失败透传')
{
  // 覆盖必须在 createApp 之前注入（createApp 内部对 deps 做展开拷贝）
  const { app } = makeApp({}, { saveDeployResult: { ok: false, step: 3, error: 'x' } })
  const res = await app.request('/api/save-deploy', { method: 'POST' })
  const body = await res.json()
  check(res.status === 200, 'HTTP 200（业务失败非 HTTP 错误）')
  check(
    body.ok === false && body.step === 3 && body.error === 'x',
    'body 逐字段透传 mock 返回值'
  )
}

// ── 测试 14：save 仅两步（不部署）──
section('测试 14: POST /api/save 仅两步')
{
  const { app, deps, store } = makeApp()
  const res = await app.request('/api/save', { method: 'POST' })
  const body = await res.json()
  check(res.status === 200 && body.ok === true, 'HTTP 200 { ok: true }')
  check(deps.calls.includes('write-models-json'), '调用 writeModelsJson（第 2 步）')
  check(!deps.calls.includes('saveAndDeploy'), '未调用 saveAndDeploy（不部署）')
  check(store.saves.length === 1, 'state 已保存（第 1 步）')
}

// ── 测试 15：runSyncFlow 纯函数（不经 HTTP）──
section('测试 15: runSyncFlow 纯函数')
{
  const deps = makeDeps()
  const events = []
  const result = await runSyncFlow({
    config: fakeConfig,
    gatewayToken: 't',
    mgmtToken: 'm',
    state: {},
    deps,
    onEvent: (ev) => events.push(ev),
  })
  check(result.summary.newModels.length === 1, 'summary.newModels 正确')
  check(result.summary.errors.length === 0, 'summary.errors 为空')
  check(events.some((e) => e.type === 'phase' && e.phase === 'provider-sync'), '收到 provider-sync phase')
  check(events.some((e) => e.type === 'phase' && e.phase === 'discover'), '收到 discover phase')
  check(events.some((e) => e.type === 'phase' && e.phase === 'enrich'), '收到 enrich phase')
  check(events.some((e) => e.type === 'enrich' && e.enriched === 1 && e.total === 1), 'enrich 事件计数正确')
  check(events.some((e) => e.type === 'discover' && e.status === 'done'), 'discover onProgress 原样透传')
  check(result.state['custom-agnes/agnes'] !== undefined, '返回 state 含新模型')
}

// ── 测试 16：runSyncFlow enrich 失败静默 ──
section('测试 16: runSyncFlow enrich 失败静默')
{
  const deps = makeDeps({ enrichFail: true })
  const result = await runSyncFlow({
    config: fakeConfig,
    gatewayToken: 't',
    mgmtToken: 'm',
    state: {},
    deps,
  })
  check(result.summary.newModels.length === 1, 'enrich 失败不中断，newModels 完整')
  check(result.state['custom-agnes/agnes'] !== undefined, 'state 仍含新模型')
}

// ── 测试 17a：调试日志开关 API ──
section('测试 17a: GET/POST /api/settings/debug')
{
  const setCalls = []
  const app = createApp({
    stateStore: makeStore(),
    configStore: { load: () => ({ ...fakeConfig, debug: true }) },
    deps: { setDebugFlag: (v) => { setCalls.push(v); return { backupPath: null } } },
  })
  const res = await app.request('/api/settings/debug')
  const body = await res.json()
  check(res.status === 200 && body.ok === true && body.enabled === true, 'GET 返回 config.debug 状态')

  const resOn = await app.request('/api/settings/debug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  const bodyOn = await resOn.json()
  check(resOn.status === 200 && bodyOn.ok === true && bodyOn.enabled === true, 'POST enabled:true → 200 ok')
  check(setCalls.length === 1 && setCalls[0] === true, 'setDebugFlag 收到 true')

  const resBad = await app.request('/api/settings/debug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check(resBad.status === 400, '缺 enabled 字段 → 400')

  const resNonJson = await app.request('/api/settings/debug', { method: 'POST', body: 'not json' })
  check(resNonJson.status === 400, '非法 JSON 体 → 400')

  const appFail = createApp({
    stateStore: makeStore(),
    configStore: { load: () => fakeConfig },
    deps: { setDebugFlag: () => { throw new Error('写盘失败') } },
  })
  const resFail = await appFail.request('/api/settings/debug', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  const bodyFail = await resFail.json()
  check(resFail.status === 500 && (bodyFail.error || '').includes('写盘失败'), '写盘抛错 → 500 + error 透传')

  const appOff = createApp({
    stateStore: makeStore(),
    configStore: { load: () => fakeConfig },
    deps: { setDebugFlag: () => ({ backupPath: null }) },
  })
  const resOff = await appOff.request('/api/settings/debug')
  const bodyOff = await resOff.json()
  check(bodyOff.ok === true && bodyOff.enabled === false, 'debug 未配置 → enabled:false')
}

// ── 测试 17b：setDebugFlag（注入内存 fs，零写盘）──
section('测试 17b: setDebugFlag 写回 providers.json')
{
  const makeMemFs = (initial) => {
    const files = { ...initial }
    return {
      files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      },
      writeFileSync: (p, c) => { files[p] = c },
      existsSync: (p) => p in files,
      configPath: 'cfg',
      backupPath: 'bak',
    }
  }
  const original = JSON.stringify({
    gateway: { host: 'h', accountId: 'a', gatewayId: 'g' },
    kv: { namespaceId: 'n' },
    providers: [{ id: 'p1', name: 'P1', enabled: true }],
  })
  const fsMem = makeMemFs({ cfg: original })
  setDebugFlag(true, fsMem)
  const after = JSON.parse(fsMem.files.cfg)
  check(after.debug === true, '开启 → 顶层 debug:true')
  check(!!after.gateway && after.kv.namespaceId === 'n' && after.providers.length === 1, '其余字段原样保留')
  check(fsMem.files.bak === original, '写前备份原文件内容')
  setDebugFlag(false, fsMem)
  check(!('debug' in JSON.parse(fsMem.files.cfg)), '关闭 → debug 字段移除')
  {
    const fsMissing = makeMemFs({})
    let threw = false
    try { setDebugFlag(true, fsMissing) } catch { threw = true }
    check(threw, 'providers.json 缺失 → 抛错不创建')
    const fsBroken = makeMemFs({ cfg: '{ broken' })
    let threwBroken = false
    try { setDebugFlag(true, fsBroken) } catch { threwBroken = true }
    check(threwBroken && !('bak' in fsBroken.files), 'JSON 损坏 → 抛错且不覆盖（无备份/写入）')
  }
}

// ── 测试 17：回归——任务 26 模型 API 仍可用 ──
section('测试 17: 回归——任务 26 toggle 端点')
{
  const initial = {
    'custom-agnes/agnes': { status: 'selected', provider: 'custom-agnes', metadata: {} },
  }
  const { app } = makeApp(initial)
  const res = await app.request('/api/models/toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ modelId: 'custom-agnes/agnes' }),
  })
  const body = await res.json()
  check(res.status === 200 && body.ok === true, 'toggle 端点正常')
  check(body.entry.status === 'hidden', '状态已切换')
}

// ── 测试 18：单 Provider 同步 — body { provider } 跳过 provider-sync ──
section('测试 18: POST /api/sync { provider } 跳过 provider-sync')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app, deps } = makeApp()
    const res = await app.request('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom-agnes' }),
    })
    const body = await res.json()
    check(res.status === 200 && body.ok === true, 'HTTP 200 ok')
    check(!deps.calls.includes('provider-sync'), '未调用 provider-sync（跳过）')
    check(deps.calls.includes('discover'), '仍调用 discover')
    check(deps.calls.includes('enrich'), '仍调用 enrich')
    check(
      deps.discoverFilters[0] === 'custom-agnes',
      'discoverModels 收到 providerFilter=custom-agnes'
    )
  } finally {
    restoreEnv()
  }
}

// ── 测试 19：单 Provider 同步 — SSE 无 provider-sync 阶段事件 ──
section('测试 19: 单 Provider 同步 SSE 事件序列')
{
  const restoreEnv = withCleanEnv()
  try {
    const { app } = makeApp()
    const ssePromise = app.request('/api/sync/progress')
    const postRes = await app.request('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'custom-agnes' }),
    })
    check(postRes.status === 200, 'POST /api/sync { provider } 200')
    const sseRes = await ssePromise
    const events = parseSseEvents(await sseRes.text())
    const types = events.map((e) => e.type)
    // 单 Provider 模式：无 provider-sync 事件，也无 provider-sync phase
    check(!types.includes('provider-sync'), 'SSE 无 provider-sync 事件')
    // 必需事件：discover phase → discover → enrich phase → enrich → done
    const required = ['phase', 'discover', 'phase', 'enrich', 'done']
    let i = 0
    for (const t of types) {
      if (t === required[i]) i++
    }
    check(i === required.length, `事件序列含全部必需阶段（实际: ${types.join(',')}）`)
    const doneEv = events.find((e) => e.type === 'done')
    check(!!doneEv && doneEv.data.summary.newModels.length === 1, 'done summary 正确')
  } finally {
    restoreEnv()
  }
}

// ── 测试 20：无 body / 空 provider → 全量同步（向后兼容） ──
section('测试 20: 无 body / 空 provider 向后兼容')
{
  const restoreEnv = withCleanEnv()
  try {
    // 无 body（原始调用方式）
    const { app: app1, deps: deps1 } = makeApp()
    const res1 = await app1.request('/api/sync', { method: 'POST' })
    check(res1.status === 200, '无 body → 200')
    check(deps1.calls.includes('provider-sync'), '无 body 仍执行 provider-sync')
    check(deps1.discoverFilters[0] === null, '无 body → providerFilter=null')

    // body.provider 为空字符串
    const { app: app2, deps: deps2 } = makeApp()
    const res2 = await app2.request('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: '  ' }),
    })
    check(res2.status === 200, '空 provider → 200')
    check(deps2.calls.includes('provider-sync'), '空 provider 仍执行 provider-sync')
    check(deps2.discoverFilters[0] === null, '空 provider → providerFilter=null')
  } finally {
    restoreEnv()
  }
}

// ── 测试 21：runSyncFlow providerFilter 纯函数 ──
section('测试 21: runSyncFlow providerFilter 纯函数')
{
  const deps = makeDeps()
  const events = []
  const result = await runSyncFlow({
    config: fakeConfig,
    gatewayToken: 't',
    mgmtToken: 'm',
    state: {},
    providerFilter: 'custom-agnes',
    deps,
    onEvent: (ev) => events.push(ev),
  })
  check(!deps.calls.includes('provider-sync'), '纯函数：跳过 provider-sync')
  check(deps.calls.includes('discover'), '纯函数：仍 discover')
  check(deps.discoverFilters[0] === 'custom-agnes', '纯函数：providerFilter 透传')
  check(result.summary.newModels.length === 1, 'summary.newModels 正确')
  const phaseEvents = events.filter((e) => e.type === 'phase').map((e) => e.phase)
  check(!phaseEvents.includes('provider-sync'), '无 provider-sync phase 事件')
  check(phaseEvents.includes('discover') && phaseEvents.includes('enrich'), '含 discover/enrich phase')
}

console.log(`\n${'='.repeat(56)}`)
console.log(`测试汇总: ${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
