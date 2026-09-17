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
function makeCountingDeps(counters, { kvReady = true } = {}) {
  return {
    readManagementToken: () => (kvReady ? 'mgmt-token' : ''),
    saveAndDeploy: async () => { counters.saveAndDeploy++; return { ok: true } },
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
  const { req } = makeApp(counters)
  const res = await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const body = await res.json()
  check(body.ok === true && body.changed === true, 'toggle 成功')
  check(body.autoDeployScheduled === true, '响应 autoDeployScheduled === true')
  check(body.autoDeployIdleMs === IDLE_MS, '响应携带 autoDeployIdleMs')
  check(counters.saveAndDeploy === 0, '响应时未立即部署（防抖中）')
  await waitDeploy()
  check(counters.saveAndDeploy === 1, '闲置后 saveAndDeploy 调用 1 次')
  check(counters.hiddenWrites === 1, 'hidden-models KV 写入 1 次')
  check(counters.manualWrites === 1, 'manual-models KV 写入 1 次')
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

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
