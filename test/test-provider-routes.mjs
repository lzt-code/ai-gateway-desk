// buildProviderRoutesJson 回归：KV 中 provider-routes 的键必须与
// worker 从 model id 解析出的 slug（即 discover.js 的 gatewaySlug）一致，
// 否则方舟等带 pathPrefix 的 custom provider 会回退到 /compat 端点。
import { buildProviderRoutesJson } from '../src/output/deploy.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ── 场景 1：custom provider 必须以 custom- 前缀作为键 ──
{
  const providers = [
    { id: 'fang-zhou', type: 'custom-provider', pathPrefix: '/api/plan/v3' },
    { id: 'agnes', type: 'custom-provider' },
    { id: 'openrouter', type: 'byok' },
  ]
  const map = JSON.parse(buildProviderRoutesJson(providers))
  check('custom provider 键带 custom- 前缀', Object.prototype.hasOwnProperty.call(map, 'custom-fang-zhou'), true)
  check('不以裸 id 作为键', Object.prototype.hasOwnProperty.call(map, 'fang-zhou'), false)
  check('pathPrefix 值透传', map['custom-fang-zhou'], '/api/plan/v3')
  check('缺少 pathPrefix 的 provider 被跳过', Object.keys(map).length, 1)
}

// ── 场景 2：端到端 slug 查找 — worker 路由逻辑 ──
{
  const providers = [
    { id: 'fang-zhou', type: 'custom-provider', pathPrefix: '/api/plan/v3' },
  ]
  const routes = JSON.parse(buildProviderRoutesJson(providers))
  // 模拟 worker extractProviderSlug
  const model = 'custom-fang-zhou/doubao-seed-evolving'
  const slug = model.slice(0, model.indexOf('/'))
  check('worker 从 model 解析出的 slug 能查到 pathPrefix', routes[slug] ?? null, '/api/plan/v3')
}

// ── 场景 3：异常入参不抛错 ──
{
  check('undefined 返回 {}', JSON.parse(buildProviderRoutesJson(undefined)), {})
  check('null 返回 {}', JSON.parse(buildProviderRoutesJson(null)), {})
  check('非数组返回 {}', JSON.parse(buildProviderRoutesJson({})), {})
  check('空数组返回 {}', JSON.parse(buildProviderRoutesJson([])), {})
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
