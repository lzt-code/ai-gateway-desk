// 任务 14 验证脚本：mergeProviders 纯逻辑（无需真实 API）
// 覆盖：新增 / 覆盖 / 保留 / 不修改入参
import {
  mergeProviders,
} from '../src/cloudflare/providers-sync.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ── 场景 1：云端有、本地没有 → 追加（enabled: true），记入 newProviders
{
  const local = [{ id: 'custom-agnes', name: 'Agnes', enabled: true }]
  const cloud = [
    { id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
    { id: 'custom-opencode', name: 'OpenCode', type: 'custom-provider', enabled: true },
  ]
  const r = mergeProviders(local, cloud)
  check('场景1 providers 长度', r.providers.length, 2)
  check('场景1 新增条目', r.providers[1], { id: 'custom-opencode', name: 'OpenCode', type: 'custom-provider', enabled: true })
  check('场景1 newProviders', r.newProviders, ['custom-opencode'])
  check('场景1 removedProviders', r.removedProviders, [])
}

// ── 场景 2：两边都有 → 保留本地 enabled，用云端 name 覆盖
{
  const local = [{ id: 'custom-agnes', name: 'Agnes 旧名', enabled: false }]
  const cloud = [
    { id: 'custom-agnes', name: 'Agnes 新名', type: 'custom-provider', enabled: true },
  ]
  const r = mergeProviders(local, cloud)
  check('场景2 保留本地 enabled', r.providers[0].enabled, false)
  check('场景2 云端 name 覆盖', r.providers[0].name, 'Agnes 新名')
  check('场景2 type 取云端', r.providers[0].type, 'custom-provider')
  check('场景2 newProviders 为空', r.newProviders, [])
}

// ── 场景 3：本地有、云端没有 → 保留本地条目，记入 removedProviders
{
  const local = [
    { id: 'custom-agnes', name: 'Agnes', enabled: true },
    { id: 'custom-shangtang', name: '商汤', enabled: false },
  ]
  const cloud = [{ id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true }]
  const r = mergeProviders(local, cloud)
  check('场景3 providers 长度', r.providers.length, 2)
  check('场景3 保留本地条目', r.providers[1], { id: 'custom-shangtang', name: '商汤', enabled: false })
  check('场景3 removedProviders', r.removedProviders, ['custom-shangtang'])
}

// ── 场景 4：BYOK 合并（id 为 provider_slug）
{
  const local = [{ id: 'openai', name: 'openai-default', enabled: true }]
  const cloud = [
    { id: 'openai', name: 'openai-别名', type: 'byok', enabled: true },
    { id: 'anthropic', name: 'anthropic-default', type: 'byok', enabled: true },
  ]
  const r = mergeProviders(local, cloud)
  check('场景4 BYOK 覆盖 name', r.providers[0].name, 'openai-别名')
  check('场景4 BYOK 保留本地 enabled', r.providers[0].enabled, true)
  check('场景4 BYOK 新增', r.newProviders, ['anthropic'])
}

// ── 场景 5：不修改入参（返回新数组、原数组不变）
{
  const local = [{ id: 'a', name: 'A', enabled: true }]
  const cloud = [{ id: 'b', name: 'B', type: 'custom-provider', enabled: true }]
  const localBefore = JSON.stringify(local)
  const cloudBefore = JSON.stringify(cloud)
  const r = mergeProviders(local, cloud)
  check('场景5 返回新数组', r.providers !== local && r.providers !== cloud, true)
  check('场景5 入参未被修改', JSON.stringify(local) === localBefore && JSON.stringify(cloud) === cloudBefore, true)
}

// ── 场景 6：边界 — 空数组 / 非法入参
{
  const r = mergeProviders([], [])
  check('场景6 双空', r, { providers: [], newProviders: [], removedProviders: [] })
  const r2 = mergeProviders(undefined, null)
  check('场景6 非法入参', r2, { providers: [], newProviders: [], removedProviders: [] })
}

// ── 场景 7：pathPrefix 本地保留（云端无此字段）
{
  const local = [{ id: 'custom-agnes', name: 'Agnes', enabled: true, pathPrefix: '/api/v3' }]
  const cloud = [{ id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true }]
  const r = mergeProviders(local, cloud)
  check('场景7 保留 pathPrefix', r.providers[0].pathPrefix, '/api/v3')
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
