/**
 * 闲置自动部署（防抖）验证脚本
 *
 * 覆盖：toggle/set-status/batch-toggle 变更后不再即时写 hidden-models KV，
 * 闲置 autoDeployIdleMs 后一次性 saveAndDeploy + 写 hidden/manual KV：
 *   - 单次变更 → 排期并部署一次
 *   - 连续变更 → 防抖合并为一次部署
 *   - KV 未就绪 → 不排期（autoDeployScheduled: false）
 *   - 手动 save-deploy → 取消待部署定时器（不重复部署）
 *   - batch-toggle → 单请求至多排期一次
 * 全程 mock 依赖与内存 stateStore，绝不触碰真实 data/ 文件与网络。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const IDLE_MS = 50
// 等待定时器触发 + 部署完成（idle + 充足余量）
const waitDeploy = () => sleep(IDLE_MS + 150)

const sampleState = {
  'openrouter/deepseek-r1': {
    status: 'selected',
    metadata: { provider: 'openrouter', name: 'DeepSeek R1' },
  },
  'openrouter/gpt-4o': {
    status: 'hidden',
    metadata: { provider: 'openrouter', name: 'GPT-4o' },
  },
  'openrouter/llama-3': {
    status: 'pending',
    metadata: { provider: 'openrouter', name: 'Llama 3' },
  },
}

const mockConfigStore = {
  load: () => ({
    gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
    kv: { namespaceId: 'ns', key: 'models' },
    providers: [{ id: 'openrouter', name: 'openrouter', type: 'byok', enabled: true }],
  }),
}

function makeStore(initial = sampleState) {
  return {
    state: structuredClone(initial),
    load() { return this.state },
    save() {},
  }
}

// 计数 mock：saveAndDeploy / hidden / manual KV 写入次数
function makeCountingDeps(counters, { kvReady = true, saveAndDeployFails = false, deployDelayMs = 0 } = {}) {
  return {
    readManagementToken: () => (kvReady ? 'mgmt-token' : ''),
    saveAndDeploy: async () => {
      counters.saveAndDeploy++
      if (deployDelayMs) await sleep(deployDelayMs)
      return saveAndDeployFails ? { ok: false, step: 3, error: new Error('deploy failed') } : { ok: true }
    },
    writeKvHiddenModels: async () => { counters.hiddenWrites++ },
    writeKvManualModels: async () => { counters.manualWrites++ },
    buildHiddenModelsMap: () => ({}),
    buildManualModelsMap: () => ({}),
  }
}

function makeApp(counters, options = {}) {
  const store = makeStore()
  const app = createApp({
    stateStore: store,
    configStore: mockConfigStore,
    deps: makeCountingDeps(counters, options),
    autoDeployIdleMs: IDLE_MS,
  })
  const req = (method, p, body) =>
    app.request(p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
  return { app, store, req }
}

// ── 测试 1：单次 toggle → 闲置后自动部署一次 ──
section('测试 1: toggle → 闲置后自动部署（models + hidden/manual KV）')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app, req } = makeApp(counters)
  const res = await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const body = await res.json()
  check(body.ok === true && body.changed === true, 'toggle 成功')
  check(body.autoDeployScheduled === true, '响应 autoDeployScheduled === true')
  check(body.autoDeployIdleMs === IDLE_MS, '响应携带 autoDeployIdleMs')
  // /api/state 暴露排期中的 autoDeployPending，供前端区分「待自动部署 / 未保存」
  const pendingBody = await (await app.request('/api/state')).json()
  check(pendingBody.autoDeployPending === true, '/api/state 排期中 autoDeployPending === true')
  check(pendingBody.autoDeployIdleMs === IDLE_MS, '/api/state 排期中携带 autoDeployIdleMs')
  check(counters.saveAndDeploy === 0, '响应时未立即部署（防抖中）')
  await waitDeploy()
  check(counters.saveAndDeploy === 1, '闲置后 saveAndDeploy 调用 1 次')
  check(counters.hiddenWrites === 1, 'hidden-models KV 写入 1 次')
  check(counters.manualWrites === 1, 'manual-models KV 写入 1 次')
  const doneBody = await (await app.request('/api/state')).json()
  check(doneBody.autoDeployPending === false, '部署完成后 autoDeployPending === false')
}

// ── 测试 1b：部署失败 → autoDeployPending 归 false（前端回退「未保存」）──
section('测试 1b: 自动部署失败 → autoDeployPending 归 false')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app, req } = makeApp(counters, { saveAndDeployFails: true })
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const pendingBody = await (await app.request('/api/state')).json()
  check(pendingBody.autoDeployPending === true, '失败前排期中 autoDeployPending === true')
  await waitDeploy()
  const doneBody = await (await app.request('/api/state')).json()
  check(doneBody.autoDeployPending === false, '部署失败后 autoDeployPending 归 false')
}

// ── 测试 2：连续多次 toggle → 防抖合并为一次部署 ──
section('测试 2: 连续 toggle（间隔 < idle）→ 仅部署一次')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { req } = makeApp(counters)
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  await sleep(20)
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/gpt-4o' })
  await sleep(20)
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/llama-3' })
  await waitDeploy()
  check(counters.saveAndDeploy === 1, '连续 3 次 toggle → saveAndDeploy 仅 1 次')
  check(counters.hiddenWrites === 1, 'hidden-models KV 仅写 1 次')
}

// ── 测试 3：KV 未就绪 → 不排期、不部署 ──
section('测试 3: KV 未就绪（无管理 Token）→ autoDeployScheduled false，不部署')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { req, store } = makeApp(counters, { kvReady: false })
  const res = await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const body = await res.json()
  check(body.changed === true, 'toggle 仍生效（本地状态变更）')
  check(body.autoDeployScheduled === false, 'autoDeployScheduled === false')
  check(store.state['openrouter/deepseek-r1'].status === 'hidden', '本地 state 已变更为 hidden')
  await waitDeploy()
  check(counters.saveAndDeploy === 0, 'saveAndDeploy 未调用')
  check(counters.hiddenWrites === 0, 'hidden-models KV 未写入')
}

// ── 测试 4：手动 save-deploy 取消待部署定时器 ──
section('测试 4: toggle 后立即手动 save-deploy → 不重复自动部署')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { req } = makeApp(counters)
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const res = await req('POST', '/api/save-deploy')
  const body = await res.json()
  check(body.ok === true, '手动 save-deploy 成功')
  check(counters.saveAndDeploy === 1, '手动部署调用 1 次')
  await waitDeploy()
  check(counters.saveAndDeploy === 1, '定时器已取消：无第二次自动部署')
}

// ── 测试 5：set-status / batch-toggle 同样排期（单请求一次） ──
section('测试 5: set-status / batch-toggle → 各排期一次')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { req } = makeApp(counters)
  const res = await req('POST', '/api/models/set-status', { modelId: 'openrouter/llama-3', status: 'selected' })
  const body = await res.json()
  check(body.autoDeployScheduled === true, 'set-status 响应 autoDeployScheduled === true')
  await waitDeploy()
  check(counters.saveAndDeploy === 1, 'set-status 闲置后部署 1 次')

  const res2 = await req('POST', '/api/models/batch-toggle', { modelIds: ['openrouter/deepseek-r1', 'openrouter/gpt-4o'] })
  const body2 = await res2.json()
  check(body2.autoDeployScheduled === true, 'batch-toggle 响应 autoDeployScheduled === true')
  await waitDeploy()
  check(counters.saveAndDeploy === 2, 'batch-toggle（多模型）仅再部署 1 次')
}

// ── 测试 6：未变更（toggle 不存在模型除外场景）— pending 无变化不排期 ──
section('测试 6: set-status 状态未变化 → 不排期')
{
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { req } = makeApp(counters)
  const res = await req('POST', '/api/models/set-status', { modelId: 'openrouter/deepseek-r1', status: 'selected' })
  const body = await res.json()
  check(body.changed === false, '状态未变化 → changed === false')
  check(body.autoDeployScheduled === false, 'autoDeployScheduled === false')
  await waitDeploy()
  check(counters.saveAndDeploy === 0, 'saveAndDeploy 未调用')
}

// ── 测试 7：退出前冲刷待部署（flushPendingDeploy，页面关闭场景）──
section('测试 7: 退出前冲刷待部署')
{
  // 7a：排期中调用 flush → 立即部署（不等 idle），且仅一次
  const counters = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app, req } = makeApp(counters)
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  check(counters.saveAndDeploy === 0, 'flush 前未部署（防抖中）')
  await app.flushPendingDeploy()
  check(counters.saveAndDeploy === 1, 'flush 立即触发部署 1 次')
  check(counters.hiddenWrites === 1, 'flush 写入 hidden-models KV')
  await waitDeploy()
  check(counters.saveAndDeploy === 1, '原防抖定时器已取消：无重复部署')
  const stateBody = await (await app.request('/api/state')).json()
  check(stateBody.autoDeployPending === false, 'flush 后 autoDeployPending === false')

  // 7b：无待部署 → flush 安全空转（不调用 saveAndDeploy）
  const counters2 = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app: app2 } = makeApp(counters2)
  await app2.flushPendingDeploy()
  check(counters2.saveAndDeploy === 0, '无待部署时 flush 不触发部署')

  // 7c：部署进行中调用 flush → 等待同一 promise，不重复部署
  const counters3 = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app: app3, req: req3 } = makeApp(counters3, { deployDelayMs: 60 })
  await req3('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const runP = app3.flushPendingDeploy()
  const runP2 = app3.flushPendingDeploy()
  await Promise.all([runP, runP2])
  check(counters3.saveAndDeploy === 1, '部署中重复 flush 仅部署 1 次')

  // 7d：flush 超时兜底：部署挂起时不阻塞退出
  const counters4 = { saveAndDeploy: 0, hiddenWrites: 0, manualWrites: 0 }
  const { app: app4, req: req4 } = makeApp(counters4, { deployDelayMs: 500 })
  await req4('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const t0 = Date.now()
  await app4.flushPendingDeploy(50)
  check(Date.now() - t0 < 400, 'flush 超时兜底：挂起部署不阻塞退出')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
