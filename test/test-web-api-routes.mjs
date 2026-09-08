/**
 * 动态路由配置 API 端点验证脚本（全 mock，零触网零写盘）
 *
 * 覆盖：
 *  - GET /api/routes/config：本地条目 + 云端存在性合并 / 无 Token 降级 readonly
 *  - POST /api/routes/save：合法保存 dirty=true / 非法 name / elements 校验失败 400 带明细
 *  - POST /api/routes/deploy：单条部署成功回写 cloudId/version/dirty=false /
 *    默认部署全部 dirty / 部分失败汇总 / 缺 Token 400 / 未知路由 404
 *  - POST /api/routes/delete：仅本地 / 含云端（404 视为成功）/ 云端失败保留本地已删
 *  - POST /api/routes/refresh：云端 elements 覆盖本地（dirty 归零）/ 详情缺失降级
 */

import { createApp } from '../src/web/server.js'
import { validateRouteElements } from '../src/pipeline/routes-validate.js'
import { upsertRoute, removeRoute } from '../src/core/routes-store.js'

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

const ELEMENTS = [
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]

// ── fixtures ─────────────────────────────────────────────

function makeRoutesStore(initial = { routes: {} }) {
  const store = { state: structuredClone(initial), saves: 0 }
  store.load = () => store.state
  store.save = (s) => {
    store.saves++
    store.state = s
  }
  return store
}

const CONFIG = {
  gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
  kv: { namespaceId: 'ns', key: 'models' },
  providers: [],
}

const baseDeps = {
  readToken: () => 'cfut-local',
  readManagementToken: () => 'mgt-local',
  validateRouteElements,
  upsertRoute,
  removeRoute,
}

function makeApp({ routesStore, deps }) {
  return createApp({
    configStore: { load: () => structuredClone(CONFIG) },
    stateStore: { load: () => ({}), save: () => {} },
    routesStore,
    deps: { ...baseDeps, ...deps },
  })
}

// env 隔离：清掉 CLOUDFLARE_API_TOKEN 避免 env 优先穿透 mock
const ENV_TOKEN = process.env.CLOUDFLARE_API_TOKEN
delete process.env.CLOUDFLARE_API_TOKEN

try {
  // ── 1：GET /api/routes/config ───────────────────────────
  section('GET /api/routes/config')
  {
    const store = makeRoutesStore({
      routes: {
        support: { name: 'support', elements: ELEMENTS, cloudId: 'u1', deployedVersion: 3, dirty: false },
        draft: { name: 'draft', elements: ELEMENTS, dirty: true },
      },
    })
    const app = makeApp({
      routesStore: store,
      deps: { listDynamicRoutes: async () => [{ id: 'u1', name: 'support' }, { id: 'u9', name: 'cloud-only' }] },
    })
    const res = await app.request('/api/routes/config')
    const body = await res.json()
    check(res.status === 200 && body.ok, '200 + ok')
    check(body.routes.length === 2 && body.routes[0].name === 'draft' && body.routes[1].name === 'support',
      '本地条目按名称排序返回')
    const support = body.routes.find((r) => r.name === 'support')
    check(support.cloudExists === true && support.deployedVersion === 3 && support.dirty === false,
      '云端存在性 / 已部署版本 / dirty 合并正确')
    check(body.cloudRoutes.length === 2 && body.cloudRoutes[1].name === 'cloud-only',
      'cloudRoutes 透出（含本地没有的云端路由）')
    check(body.readonly === false, '有 Token + gateway → 非 readonly')
  }
  {
    const app = makeApp({
      routesStore: makeRoutesStore(),
      deps: { readManagementToken: () => null, listDynamicRoutes: async () => { throw new Error('should not be called') } },
    })
    const res = await app.request('/api/routes/config')
    const body = await res.json()
    check(body.readonly === true && body.cloudRoutes === null, '无管理 Token → readonly 降级，不触云端')
  }
  {
    const app = makeApp({
      routesStore: makeRoutesStore(),
      deps: { listDynamicRoutes: async () => { throw new Error('net down') } },
    })
    const res = await app.request('/api/routes/config')
    const body = await res.json()
    check(body.cloudRoutes === null && /net down/.test(body.cloudError), '云端拉取失败 → cloudError 透出，不 500')
  }
  // ?local=1：跳过云端拉取，仅返回本地条目（cloudExists=null，cloudPending=true）
  {
    let cloudCalled = 0
    const store = makeRoutesStore({
      routes: { support: { name: 'support', elements: ELEMENTS, cloudId: 'u1', deployedVersion: 3 } },
    })
    const app = makeApp({
      routesStore: store,
      deps: { listDynamicRoutes: async () => { cloudCalled++; return [{ id: 'u1', name: 'support' }] } },
    })
    const res = await app.request('/api/routes/config?local=1')
    const body = await res.json()
    check(res.status === 200 && body.ok, '?local=1 → 200 + ok')
    check(cloudCalled === 0, '?local=1 不触网（listDynamicRoutes 未调用）')
    check(body.cloudRoutes === null, '?local=1 → cloudRoutes=null')
    check(body.cloudPending === true, '?local=1 → cloudPending=true（提示前端仍有待同步云端数据）')
    const support = body.routes[0]
    check(support.cloudExists === null, '?local=1 → 本地条目 cloudExists=null（未知，非 false）')
    check(support.deployedVersion === 3, '?local=1 → 本地跟踪字段仍透出（deployedVersion）')
  }
  // ?local=1 但无管理 Token：cloudPending=false（无云端可同步），readonly=true
  {
    const app = makeApp({
      routesStore: makeRoutesStore(),
      deps: { readManagementToken: () => null },
    })
    const res = await app.request('/api/routes/config?local=1')
    const body = await res.json()
    check(body.cloudPending === false && body.readonly === true, '?local=1 无 Token → cloudPending=false + readonly')
  }

  // ── 2：POST /api/routes/save ────────────────────────────
  section('POST /api/routes/save')
  {
    const store = makeRoutesStore()
    const app = makeApp({ routesStore: store, deps: {} })
    const res = await app.request('/api/routes/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'support', elements: ELEMENTS }),
    })
    const body = await res.json()
    check(res.status === 200 && body.ok && body.entry.dirty === true, '合法保存 → dirty=true')
    check(store.saves === 1 && store.state.routes.support.elements.length === 2, '落盘一次')
    const res2 = await app.request('/api/routes/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad_Name', elements: ELEMENTS }),
    })
    check(res2.status === 400, '非法 name → 400')
    const res3 = await app.request('/api/routes/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'broken', elements: [{ id: 'x' }] }),
    })
    const body3 = await res3.json()
    check(res3.status === 400 && Array.isArray(body3.errors) && body3.errors.length > 0,
      'elements 校验失败 → 400 带 errors 明细')
  }

  // ── 3：POST /api/routes/deploy ──────────────────────────
  section('POST /api/routes/deploy')
  {
    const store = makeRoutesStore({
      routes: {
        a: { name: 'a', elements: ELEMENTS, dirty: true },
        b: { name: 'b', elements: ELEMENTS, dirty: true },
        c: { name: 'c', elements: ELEMENTS, dirty: false },
      },
    })
    const deployed = []
    const app = makeApp({
      routesStore: store,
      deps: {
        deployRouteConfig: async (t, acc, gw, entry) => {
          deployed.push(entry.name)
          if (entry.name === 'b') return { ok: false, error: 'cloud boom' }
          return { ok: true, cloudId: `uuid-${entry.name}`, version: 1 }
        },
      },
    })
    const res = await app.request('/api/routes/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json()
    check(JSON.stringify(deployed) === JSON.stringify(['a', 'b']), '缺省仅部署 dirty 条目（a、b）')
    check(body.ok === false && body.results.length === 2, '部分失败 → ok=false + 结果汇总')
    check(body.results[0].ok === true && body.results[0].version === 1, '成功条目返回版本号')
    check(body.results[1].ok === false && /boom/.test(body.results[1].error), '失败条目透出错误')
    check(store.state.routes.a.dirty === false && store.state.routes.a.deployedVersion === 1,
      '成功条目回写 dirty=false + deployedVersion')
    check(store.state.routes.b.dirty === true, '失败条目保持 dirty')
    check(store.state.routes.c.dirty === false && deployed.length === 2, '非 dirty 条目不触发部署')
  }
  {
    const store = makeRoutesStore({ routes: { a: { name: 'a', elements: ELEMENTS, dirty: true } } })
    const deployed = []
    const app = makeApp({
      routesStore: store,
      deps: {
        deployRouteConfig: async (t, acc, gw, entry) => { deployed.push(entry.name); return { ok: true, cloudId: 'u', version: 2 } },
      },
    })
    const res = await app.request('/api/routes/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a' }),
    })
    const body = await res.json()
    check(body.ok === true && deployed.length === 1, '指定 name → 单条部署')
    const res404 = await app.request('/api/routes/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ghost' }),
    })
    check(res404.status === 404, '未知路由 → 404')
  }
  {
    const app = makeApp({
      routesStore: makeRoutesStore({ routes: { a: { name: 'a', elements: ELEMENTS, dirty: true } } }),
      deps: { readManagementToken: () => null },
    })
    const res = await app.request('/api/routes/deploy', { method: 'POST' })
    check(res.status === 400, '缺管理 Token → 400')
  }

  // ── 4：POST /api/routes/delete ──────────────────────────
  section('POST /api/routes/delete')
  {
    const store = makeRoutesStore({
      routes: { a: { name: 'a', elements: ELEMENTS, cloudId: 'uuid-a' } },
    })
    const cloudCalls = []
    const app = makeApp({
      routesStore: store,
      deps: {
        deleteDynamicRoute: async (t, acc, gw, id) => { cloudCalls.push(id); return null },
      },
    })
    const res = await app.request('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', cloud: true }),
    })
    const body = await res.json()
    check(body.ok && body.cloudDeleted && cloudCalls.length === 1 && cloudCalls[0] === 'uuid-a',
      'cloud=true → 云端删除（用 cloudId）')
    check(store.state.routes.a === undefined, '本地条目已删')
  }
  {
    const store = makeRoutesStore({
      routes: { a: { name: 'a', elements: ELEMENTS, cloudId: 'uuid-a' } },
    })
    const app = makeApp({
      routesStore: store,
      deps: {
        deleteDynamicRoute: async () => {
          const err = new Error('gone')
          err.status = 404
          throw err
        },
      },
    })
    const res = await app.request('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', cloud: true }),
    })
    const body = await res.json()
    check(res.status === 200 && body.ok && body.cloudDeleted, '云端 404 → 视为删除成功')
    check(store.state.routes.a === undefined, '本地条目仍被删除')
  }
  {
    const store = makeRoutesStore({
      routes: { a: { name: 'a', elements: ELEMENTS, cloudId: 'uuid-a' } },
    })
    const app = makeApp({
      routesStore: store,
      deps: {
        deleteDynamicRoute: async () => { throw new Error('boom') },
      },
    })
    const res = await app.request('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', cloud: true }),
    })
    const body = await res.json()
    check(body.ok === false && /boom/.test(body.cloudError), '云端删除失败 → ok=false + cloudError')
    check(store.state.routes.a === undefined, '云端失败不影响本地已删')
  }

  // ── 5：POST /api/routes/refresh ─────────────────────────
  section('POST /api/routes/refresh')
  {
    const store = makeRoutesStore({
      routes: { support: { name: 'support', elements: [{ id: 'stale' }], dirty: true } },
    })
    const CLOUD_ELEMENTS = [
      { id: 'START', type: 'start', outputs: { next: { elementId: 'm' } } },
      { id: 'm', type: 'model', properties: { provider: 'p', model: 'm' }, outputs: { success: { elementId: 'END' } } },
      { id: 'END', type: 'end', outputs: {} },
    ]
    const app = makeApp({
      routesStore: store,
      deps: {
        listDynamicRoutes: async () => [
          { id: 'uuid-s', name: 'support' },
          { id: 'uuid-broken', name: 'broken' },
        ],
        getDynamicRouteDetail: async (t, a, g, id) => {
          if (id === 'uuid-s') return { version: { version: 4, data: CLOUD_ELEMENTS } }
          return { version: { version: 1 } } // 缺 data → 降级
        },
      },
    })
    const res = await app.request('/api/routes/refresh', { method: 'POST' })
    const body = await res.json()
    check(body.ok === false && body.results.length === 2, '一条失败 → ok=false 汇总')
    const support = store.state.routes.support
    check(support.elements.length === 3 && support.dirty === false && support.cloudId === 'uuid-s' && support.deployedVersion === 4,
      '云端 elements 覆盖本地 + dirty 归零 + 版本回写')
    check(store.state.routes.broken === undefined, '详情缺 version.data 的路由不写入')
  }

  // ── 6：请求体防御 ────────────────────────────────────────
  section('请求体防御')
  {
    const app = makeApp({ routesStore: makeRoutesStore(), deps: {} })
    const res = await app.request('/api/routes/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    check(res.status === 400, '非法 JSON body → 400')
    const res2 = await app.request('/api/routes/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'UPPER' }),
    })
    check(res2.status === 400, 'delete 非法 name → 400')
  }
} finally {
  if (ENV_TOKEN !== undefined) process.env.CLOUDFLARE_API_TOKEN = ENV_TOKEN
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
