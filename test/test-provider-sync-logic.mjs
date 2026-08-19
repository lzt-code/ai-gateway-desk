// 任务 15 验证脚本：syncProvidersToConfig 纯函数（注入 mock syncFn，不触网）
// 覆盖：有 Token + 成功 / 有 Token + 抛错 / 无 Token 跳过 / 结果透传 / 默认 syncFn
import {
  syncProvidersToConfig,
} from '../src/tui/actions.js'
import { syncProviders as realSyncProviders } from '../src/cloudflare/providers-sync.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ── 场景 A：有管理 Token + mock 成功
//    → 返回 ok:true；result.newProviders 含 'new-p'；config.providers 被就地替换
//    → mock 收到的参数为 (config, apiToken)
{
  const config = {
    gateway: { accountId: 'acc', gatewayId: 'gw' },
    providers: [{ id: 'custom-agnes', name: 'Agnes', enabled: true }],
  }
  const apiToken = 'mgmt-token-a'
  const mockResult = {
    providers: [
      { id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
      { id: 'new-p', name: 'New P', type: 'custom-provider', enabled: true },
    ],
    newProviders: ['new-p'],
    removedProviders: [],
    errors: [],
  }
  let mockArgs = null
  const mockSyncFn = async (...args) => {
    mockArgs = args
    return mockResult
  }

  const r = await syncProvidersToConfig(config, apiToken, mockSyncFn)
  check('场景A ok', r.ok, true)
  check('场景A skipped 未设置', r.skipped, undefined)
  check('场景A result.newProviders', r.result.newProviders, ['new-p'])
  check('场景A config.providers 已替换', config.providers, mockResult.providers)
  check('场景A mock 参数 (config, apiToken)', [mockArgs[0] === config, mockArgs[1]], [true, apiToken])
}

// ── 场景 B：有管理 Token + mock 抛错
//    → 返回 ok:false，error.message 透传；不向上抛（await 不 reject）；config.providers 不变
{
  const config = {
    gateway: { accountId: 'acc', gatewayId: 'gw' },
    providers: [{ id: 'custom-agnes', name: 'Agnes', enabled: true }],
  }
  const apiToken = 'mgmt-token-b'
  const providersBefore = config.providers
  const mockSyncFn = async () => {
    throw new Error('401 Unauthorized')
  }

  let rejected = false
  let r = null
  try {
    r = await syncProvidersToConfig(config, apiToken, mockSyncFn)
  } catch {
    rejected = true
  }
  check('场景B 不向上抛', rejected, false)
  check('场景B ok:false', r.ok, false)
  check('场景B error.message', r.error.message, '401 Unauthorized')
  check('场景B config.providers 不变', config.providers, providersBefore)
}

// ── 场景 C：无管理 Token（undefined / 空串 '' 各一次）
//    → 返回 { ok:false, skipped:true }；mock 完全未被调用（调用计数为 0）
{
  const config = { gateway: {}, providers: [] }
  for (const token of [undefined, '']) {
    let callCount = 0
    const mockSyncFn = async () => {
      callCount++
      return { providers: [] }
    }
    const r = await syncProvidersToConfig(config, token, mockSyncFn)
    check(`场景C token=${JSON.stringify(token)} ok:false`, r.ok, false)
    check(`场景C token=${JSON.stringify(token)} skipped:true`, r.skipped, true)
    check(`场景C token=${JSON.stringify(token)} mock 未调用`, callCount, 0)
  }
}

// ── 场景 D：removedProviders / errors 非空
//    → result 原样透传（计数由 UI 层判断，纯函数不过滤）
{
  const config = { gateway: {}, providers: [] }
  const apiToken = 'mgmt-token-d'
  const mockResult = {
    providers: [{ id: 'keep', name: 'Keep', enabled: true }],
    newProviders: [],
    removedProviders: ['old-p'],
    errors: [{ source: 'provider_configs', error: new Error('boom') }],
  }
  const mockSyncFn = async () => mockResult

  const r = await syncProvidersToConfig(config, apiToken, mockSyncFn)
  check('场景D ok:true', r.ok, true)
  check('场景D result 原样透传', r.result, mockResult)
  check('场景D removedProviders 透传', r.result.removedProviders, ['old-p'])
  check('场景D errors 透传', r.result.errors, mockResult.errors)
}

// ── 场景 E：默认 syncFn 兜底
//    → 不传 syncFn 时，函数内部默认值为 syncProviders
{
  // 默认参数在函数定义时绑定 actions.js 模块作用域中的 syncProviders 导入；
  // actions.js 与测试文件都从同一 providers-sync.js 模块实例导入（ESM 单例缓存），
  // 因此默认参数与 realSyncProviders 必然同引用。
  const defMatch = syncProvidersToConfig.toString().match(/syncFn = (\w+)/)
  check('场景E 默认参数名为 syncProviders', defMatch?.[1], 'syncProviders')
  check('场景E 真实 syncProviders 为函数', typeof realSyncProviders, 'function')
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
