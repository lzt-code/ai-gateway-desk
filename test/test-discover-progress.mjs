// discoverModels 进度回调验证（mock fetch，无需真实 API）
// 覆盖：pending/done/error 事件序列、done/total 计数、无回调向后兼容、
//       custom provider 自动加 custom- 前缀、OpenRouter 原生格式（无 object 字段）
import { discoverModels, gatewaySlug } from '../src/cloudflare/discover.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// mock fetch：按 URL 分段返回不同响应
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const s = String(url)
  if (s.includes('/p1/v1/models')) {
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (s.includes('/p2/v1/models')) {
    return new Response('err', { status: 500, statusText: 'Internal Server Error' })
  }
  if (s.includes('/custom-agnes/v1/models')) {
    // OpenAI 标准格式（custom provider 上游）
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'agnes-2.0-flash' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (s.includes('/openrouter/v1/models')) {
    // OpenRouter 原生格式：只有 data 数组，无 object 字段
    return new Response(JSON.stringify({ data: [{ id: 'inclusionai/ling-3.0-tiny:free', name: 'Ling' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (s.includes('/bad/v1/models')) {
    // 网关错误体：400 Invalid provider
    return new Response(JSON.stringify({ success: false, error: [{ code: 2008, message: 'Invalid provider' }], message: 'Invalid provider' }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}

try {
  // ── 场景 0：gatewaySlug 计算（custom- 前缀 / byok 原样） ──
  {
    check('场景0 custom-provider 加前缀', gatewaySlug({ id: 'agnes', type: 'custom-provider' }), 'custom-agnes')
    check('场景0 已带前缀不重复', gatewaySlug({ id: 'custom-agnes', type: 'custom-provider' }), 'custom-agnes')
    check('场景0 byok 原样', gatewaySlug({ id: 'openrouter', type: 'byok' }), 'openrouter')
    check('场景0 无 type 原样', gatewaySlug({ id: 'p1' }), 'p1')
  }

  // ── 场景 1：进度回调事件序列（p1 成功 / p2 失败 / p3 跳过） ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [
        { id: 'p1', enabled: true },
        { id: 'p2', enabled: true },
        { id: 'p3', enabled: false }, // 应被跳过，不产生事件
      ],
    }
    const events = []
    const r = await discoverModels(config, 'cfut_test', (p) => events.push(p))

    check('场景1 results 长度', r.results.length, 1)
    check('场景1 results[0].provider', r.results[0]?.provider, 'p1')
    check('场景1 errors[0].provider', r.errors[0]?.provider, 'p2')

    // pending 在请求发出前按 provider 顺序同步触发
    const pendings = events.filter((e) => e.status === 'pending').map((e) => e.provider)
    check('场景1 pending 顺序', pendings, ['p1', 'p2'])

    const doneEvent = events.find((e) => e.status === 'done')
    const errorEvent = events.find((e) => e.status === 'error')
    check('场景1 恰好 1 done 1 error', [doneEvent ? 1 : 0, errorEvent ? 1 : 0], [1, 1])
    check('场景1 done.models', doneEvent?.models, 2)
    check('场景1 error.error', errorEvent?.error, '500 Internal Server Error')
    // 并行完成顺序不定，done 计数只能是 {1,2} 各一次且互不相同
    check('场景1 done/error 计数互补', [doneEvent?.done, errorEvent?.done].sort(), [1, 2])
    check('场景1 所有事件 total=2', events.every((e) => e.total === 2), true)
  }

  // ── 场景 2：无 onProgress 时向后兼容 ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [
        { id: 'p1', enabled: true },
        { id: 'p2', enabled: true },
      ],
    }
    const r = await discoverModels(config, 'cfut_test')
    check('场景2 results 长度', r.results.length, 1)
    check('场景2 errors 长度', r.errors.length, 1)
  }

  // ── 场景 3：全部禁用 → 空结果、无事件 ──
  {
    const events = []
    const r = await discoverModels({ ...{}, gateway: {}, providers: [{ id: 'x', enabled: false }] }, 't', (p) => events.push(p))
    check('场景3 空 results', r.results, [])
    check('场景3 空 errors', r.errors, [])
    check('场景3 无事件', events, [])
  }

  // ── 场景 4：custom provider 自动加 custom- 前缀，URL 正确 ──
  {
    const seen = []
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [{ id: 'agnes', type: 'custom-provider', enabled: true }],
    }
    const r = await discoverModels(config, 't', (p) => seen.push(p))
    check('场景4 results provider 用网关 slug', r.results[0]?.provider, 'custom-agnes')
    check('场景4 模型 id 前缀用网关 slug', r.results[0]?.models[0]?.id, 'custom-agnes/agnes-2.0-flash')
  }

  // ── 场景 5：OpenRouter 原生格式（无 object 字段）也能解析 ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [{ id: 'openrouter', type: 'byok', enabled: true }],
    }
    const r = await discoverModels(config, 't')
    check('场景5 解析成功', r.results.length, 1)
    check('场景5 模型 id 前缀', r.results[0]?.models[0]?.id, 'openrouter/inclusionai/ling-3.0-tiny:free')
    check('场景5 保留原始字段', r.results[0]?.models[0]?.name, 'Ling')
  }

  // ── 场景 6：网关错误体透出细节（400 Invalid provider） ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [{ id: 'bad', type: 'byok', enabled: true }],
    }
    const r = await discoverModels(config, 't')
    check('场景6 error 含网关 message', r.errors[0]?.error, '400 Bad Request: Invalid provider')
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
