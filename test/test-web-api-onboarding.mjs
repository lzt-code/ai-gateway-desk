/**
 * Web 初始化引导 API 端点测试
 *
 * 覆盖：
 *   - GET /api/account/status 的 initialized 字段（未初始化 / 已初始化 / providers.json 缺失不报错）
 *   - POST /api/onboarding/discover（成功 / 失败 / 非法 JSON body）
 *   - POST /api/onboarding/complete（成功 / 失败透传 steps）
 *
 * 全部依赖 mock（deps 注入），零触网零写盘。
 */

import { createApp } from '../src/web/server.js'
import { summarizeTokenStatus, summarizeGatewayInfo } from '../src/logic/account-actions.js'

let failures = 0
let checks = 0
function check(cond, msg) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n${name}`) }

function makeApp({ deps = {}, config = null } = {}) {
  const baseDeps = {
    readManagementToken: () => null,
    readToken: () => null,
    summarizeTokenStatus,
    summarizeGatewayInfo,
    ...deps,
  }
  const configStore = config
    ? { load: () => config }
    : { load: () => { throw new Error('data/providers.json 不存在') } }
  return createApp({
    autoDeployIdleMs: 0,
    stateStore: { load: () => ({}), save: () => {} },
    configStore,
    deps: baseDeps,
  })
}

function post(app, path, body, raw) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  })
}

// ── account status initialized ───────────────────────────

section('GET /api/account/status · initialized')
{
  delete process.env.CLOUDFLARE_API_TOKEN
  const app = makeApp()
  const res = await app.request('/api/account/status')
  const data = await res.json()
  check(res.status === 200, 'providers.json 缺失不报错 → 200')
  check(data.initialized === false, '无管理 Token → initialized:false')
  check(data.gateway.accountId === '未配置', 'gateway 缺失降级为未配置')

  const app2 = makeApp({ deps: { readManagementToken: () => 'mgt' } })
  const data2 = await (await app2.request('/api/account/status')).json()
  check(data2.initialized === true, '有本地管理 Token → initialized:true')
}

// ── discover ─────────────────────────────────────────────

section('POST /api/onboarding/discover')
{
  const calls = []
  const app = makeApp({
    deps: {
      discoverOnboarding: async (input) => {
        calls.push(input)
        return { ok: true, accounts: [{ id: 'acc-1', name: 'A' }], accountId: 'acc-1', gateways: [{ id: 'gw' }] }
      },
    },
  })
  const res = await post(app, '/api/onboarding/discover', { managementToken: 'tok' })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '成功 → ok:true')
  check(data.accountId === 'acc-1' && data.gateways.length === 1, '返回账户 + 网关')
  check(calls[0].managementToken === 'tok', '透传 managementToken')

  const app2 = makeApp({ deps: { discoverOnboarding: async () => ({ ok: false, error: '401 Unauthorized' }) } })
  const data2 = await (await post(app2, '/api/onboarding/discover', { managementToken: 'bad' })).json()
  check(data2.ok === false && data2.error.includes('401'), '失败 → 透传错误')

  const bad = await post(app, '/api/onboarding/discover', null, '{ not json')
  check(bad.status === 400, '非法 JSON → 400')
}

// ── complete ─────────────────────────────────────────────

section('POST /api/onboarding/complete')
{
  const calls = []
  const steps = [{ step: 'Gateway', ok: true, message: '已就绪' }, { step: 'cfut_xxx', ok: true, message: '已验证' }]
  const app = makeApp({
    deps: {
      completeOnboarding: async (input) => {
        calls.push(input)
        return { ok: true, steps, gatewayId: 'gw', kvNamespaceId: 'kv-1' }
      },
    },
  })
  const res = await post(app, '/api/onboarding/complete', {
    managementToken: 'tok', accountId: 'acc', gatewayId: 'gw', gatewayToken: 'cfut_x',
  })
  const data = await res.json()
  check(res.status === 200 && data.ok === true, '成功 → ok:true')
  check(data.steps.length === 2 && data.kvNamespaceId === 'kv-1', '返回 steps + kv')
  check(calls[0].gatewayToken === 'cfut_x', '透传 gatewayToken')

  const app2 = makeApp({
    deps: {
      completeOnboarding: async () => ({ ok: false, error: 'Gateway Token 验证失败', steps: [{ step: 'cfut_xxx', ok: false, message: '验证失败' }] }),
    },
  })
  const data2 = await (await post(app2, '/api/onboarding/complete', { managementToken: 't', accountId: 'a', gatewayToken: 'bad' })).json()
  check(data2.ok === false && data2.error.includes('验证失败'), '失败 → 透传错误')
  check(Array.isArray(data2.steps) && data2.steps.length === 1, '失败也带 steps 明细')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
