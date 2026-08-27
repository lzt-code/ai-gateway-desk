// discoverModels 进度回调验证（mock fetch，无需真实 API）
// 覆盖：pending/done/error 事件序列、done/total 计数、无回调向后兼容、
//       custom provider 自动加 custom- 前缀、OpenRouter 原生格式（无 object 字段）、
//       debug 模式（request/response 事件、token 脱敏、预览截断、关闭时无 debug 事件）
import { discoverModels, gatewaySlug, maskHeaders } from '../src/cloudflare/discover.js'

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
  if (s.includes('/long/v1/models')) {
    // 超长响应体（> 1000 字符）：debug 预览应截断
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'x'.repeat(1200) }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (s.includes('/notjson/v1/models')) {
    // 200 但响应不是合法 JSON（如网关 HTML 错误页透传）
    return new Response('<html>gateway error</html>', { status: 200, statusText: 'OK' })
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

  // ── 场景 7：debug 关闭（缺省）→ 无 debug 事件 ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [{ id: 'p1', enabled: true }],
    }
    const events = []
    await discoverModels(config, 'cfut_test', (p) => events.push(p))
    check('场景7 缺省无 debug 事件', events.some((e) => e.status === 'debug'), false)
  }

  // ── 场景 8：debug 开启 → request/response 事件、token 脱敏、截断预览、错误路径也发 ──
  {
    const config = {
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' },
      providers: [
        { id: 'p1', enabled: true },
        { id: 'long', enabled: true },
        { id: 'bad', enabled: true },
        { id: 'notjson', enabled: true },
      ],
      debug: true,
    }
    const events = []
    const r = await discoverModels(config, 'cfut_test', (p) => events.push(p))

    const reqEv = events.find((e) => e.status === 'debug' && e.provider === 'p1' && e.debug?.phase === 'request')
    const respEv = events.find((e) => e.status === 'debug' && e.provider === 'p1' && e.debug?.phase === 'response')
    check('场景8 request 事件存在', !!reqEv, true)
    check('场景8 request method/url', reqEv && [reqEv.debug.method, reqEv.debug.url], ['GET', 'https://gateway.ai.cloudflare.com/v1/acc-1/gw-1/p1/v1/models'])
    check('场景8 request 头脱敏', reqEv?.debug?.headers?.['cf-aig-authorization'], 'Bearer cfut****test')
    check('场景8 所有事件不含原始 token', JSON.stringify(events).includes('cfut_test'), false)

    check('场景8 response 事件 200', respEv && respEv.debug.httpStatus, 200)
    check('场景8 response 含响应头', respEv && respEv.debug.headers['content-type'], 'application/json')
    check('场景8 未截断时 truncated=false', respEv?.debug?.truncated, false)
    check('场景8 bodyPreview 为响应原文', respEv?.debug?.bodyPreview, JSON.stringify({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }))

    const longResp = events.find((e) => e.status === 'debug' && e.provider === 'long' && e.debug?.phase === 'response')
    check('场景8 超长响应 truncated', longResp?.debug?.truncated, true)
    check('场景8 bodyPreview 截断到 1000', longResp?.debug?.bodyPreview?.length, 1000)

    // 非 2xx：response debug 事件先发（带错误体预览），error 事件后到
    const badResp = events.find((e) => e.status === 'debug' && e.provider === 'bad' && e.debug?.phase === 'response')
    check('场景8 非 2xx 也有 response 事件', badResp && badResp.debug.httpStatus, 400)
    check('场景8 response 事件含错误体预览', typeof badResp?.debug?.bodyPreview === 'string' && badResp.debug.bodyPreview.includes('Invalid provider'), true)
    check('场景8 bad 仍计入 errors', r.errors.some((e) => e.provider === 'bad'), true)

    // 200 但非法 JSON → 可读错误
    const notjsonErr = r.errors.find((e) => e.provider === 'notjson')
    check('场景8 非法 JSON 错误文案', (notjsonErr?.error || '').startsWith('响应不是合法 JSON:'), true)

    // debug 事件不参与 done 计数：done/total 语义不变
    const doneCount = events.filter((e) => e.status === 'done').length
    check('场景8 done 事件数=成功 provider 数', doneCount, 2)
    check('场景8 debug 事件不改变 results', r.results.map((x) => x.provider).sort(), ['long', 'p1'])
  }

  // ── 场景 9：maskHeaders 单元 ──
  {
    const masked = maskHeaders({
      'cf-aig-authorization': 'Bearer cfut_abcdefghij1234',
      authorization: 'Basic QWxhZGRpbjpPcGVuU2VzYW1l',
      accept: 'application/json',
    })
    // token 'cfut_abcdefghij1234' 长度 19 → 首 4 + '*'×(19-8) + 尾 4
    check('场景9 Bearer token 脱敏', masked['cf-aig-authorization'], 'Bearer cfut' + '*'.repeat(11) + '1234')
    check(
      '场景9 Basic 头也脱敏（保留 scheme，不含原文）',
      masked.authorization.startsWith('Basic ') && !masked.authorization.includes('QWxhZGRpbjpPcGVu'),
      true,
    )
    check('场景9 普通头原样', masked.accept, 'application/json')
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
