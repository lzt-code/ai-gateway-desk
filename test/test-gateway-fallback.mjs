/**
 * 本地 fallback 引擎测试 — 全 mock：
 * 纯辅助函数 + 线性链触发 / 重试 / 成功短路 / 4xx 不回退 /
 * percentage 权重 / 不支持结构报错 / 缺路由 / 环
 */

import {
  createFallbackEngine,
  findRouteEntry,
  indexElements,
  unsupportedNodeError,
  pickPercentageOutput,
  isRetryableStatus,
} from '../src/gateway/fallback.js'

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

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(status) {
  return new Response('data: ok\n\n', {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// ── 图构造工具 ──
function modelNode(id, provider, model, fallbackId, extra = {}) {
  return {
    id,
    type: 'model',
    properties: { provider, model, timeout: 5000, retries: 0, ...extra },
    outputs: {
      success: { elementId: 'END' },
      fallback: { elementId: fallbackId },
    },
  }
}

const END = { id: 'END', type: 'end', outputs: {} }
const START = (firstId) => ({
  id: 'START',
  type: 'start',
  outputs: { next: { elementId: firstId } },
})

function makeStore(elements, name = 'demo') {
  return { routes: { [name]: { name, elements } } }
}

function providerFor(slug) {
  return {
    id: slug,
    type: 'custom-provider',
    base_url: `https://${slug}.example.com/`,
  }
}

function makeEngine(store, opts = {}) {
  const calls = []
  const statuses = opts.statuses || {}
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    const handler = opts.nextFetch?.()
    if (handler) return handler
    const key = url.split('/')[2].split('.')[0]
    const status = statuses[key]
    if (status instanceof Error) throw status
    return sseResponse(status ?? 200)
  }
  const engine = createFallbackEngine({
    loadRoutesStore: () => store,
    fetchFn,
    findProvider: (slug) => providerFor(slug),
    readProviderHeaders: () => ({ Authorization: 'Bearer k' }),
    random: opts.random || (() => 0.5),
  })
  return { engine, calls }
}

const body = { model: 'dynamic/demo', messages: [] }

section('1. 纯辅助函数')
{
  const store = { routes: { a: { name: 'a' } } }
  check(findRouteEntry(store, 'a')?.name === 'a', 'findRouteEntry 命中')
  check(findRouteEntry(store, 'b') === null, 'findRouteEntry 未命中 → null')
  check(findRouteEntry(null, 'a') === null, '空 store → null')

  const map = indexElements([{ id: 'x', type: 'model' }, null, { id: 'y' }])
  check(map.size === 2, 'indexElements 建立索引')
  check(map.get('x').type === 'model', '索引可取节点')

  check(
    unsupportedNodeError({ type: 'conditional' }).includes('conditional'),
    'conditional 报不支持'
  )
  check(
    unsupportedNodeError({ type: 'rate' }).includes('rate'),
    'rate 报不支持'
  )
  check(unsupportedNodeError({ type: 'model' }) === null, 'model 支持')

  check(isRetryableStatus(429), '429 可重试')
  check(isRetryableStatus(500) && isRetryableStatus(503), '5xx 可重试')
  check(!isRetryableStatus(400) && !isRetryableStatus(200), '4xx/200 不可重试')
}

section('2. percentage：权重选择')
{
  const node = {
    outputs: {
      '30%': { elementId: 'a' },
      '70%': { elementId: 'b' },
    },
  }
  check(pickPercentageOutput(node, () => 0).port === '30%', 'random=0 → 30% 分支')
  check(pickPercentageOutput(node, () => 0.5).port === '70%', 'random=0.5 → 70% 分支')
  check(pickPercentageOutput(node, () => 0.99).port === '70%', 'random=0.99 → 70% 分支')

  const bad = pickPercentageOutput({ outputs: {} }, () => 0.5)
  check(bad instanceof Error, '无权重输出 → Error')
}

section('3. 线性链：首节点成功短路')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'model-a', 'm2'),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine, calls } = makeEngine(store, { statuses: { p1: 200, p2: 200 } })
  const res = await engine.execute('demo', body)
  check(res.status === 200, '成功 → 200')
  check(calls.length === 1, '仅请求首节点')
  check(calls[0].url === 'https://p1.example.com/chat/completions', '首节点 URL')
  const sent = JSON.parse(calls[0].init.body)
  check(sent.model === 'model-a', '发送节点 model 名（无 slug）')
}

section('4. fallback：可重试错误耗尽后进入下一级')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'model-a', 'm2', { retries: 1 }),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine, calls } = makeEngine(store, { statuses: { p1: 429, p2: 200 } })
  const res = await engine.execute('demo', body)
  check(res.status === 200, 'backup 成功 → 200')
  check(calls.length === 3, 'm1 重试 1 次（共 2）+ m2 1 次 = 3 次请求')
  check(calls[0].url.includes('p1'), '前两次打 p1')
  check(calls[2].url.includes('p2'), '第三次打 p2')
}

section('5. 5xx / 网络失败同样回退')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'model-a', 'm2'),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine } = makeEngine(store, {
    statuses: { p1: new TypeError('network down'), p2: 200 },
  })
  const res = await engine.execute('demo', body)
  check(res.status === 200, '网络失败后 backup 成功')
}

section('6. 4xx（非 429）立即报错，不回退')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'model-a', 'm2'),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine, calls } = makeEngine(store, { statuses: { p1: 400, p2: 200 } })
  const res = await engine.execute('demo', body)
  check(res.status === 400, '400 直接返回')
  check(calls.length === 1, '未进入 fallback')
}

section('7. 全部失败 → 502')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'model-a', 'm2'),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine } = makeEngine(store, { statuses: { p1: 500, p2: 429 } })
  const res = await engine.execute('demo', body)
  const text = await res.text()
  check(res.status === 502, '所有候选失败 → 502')
  check(text.includes('所有候选均失败'), '错误文案包含汇总')
}

section('8. percentage 节点随机分支')
{
  const percentNode = {
    id: 'pct',
    type: 'percentage',
    outputs: {
      '50%': { elementId: 'm1' },
      '50%': { elementId: 'm2' },
    },
  }
  const store = makeStore([
    { id: 'START', type: 'start', outputs: { next: { elementId: 'pct' } } },
    percentNode,
    modelNode('m1', 'p1', 'model-a', 'END'),
    modelNode('m2', 'p2', 'model-b', 'END'),
    END,
  ])
  const { engine: e1 } = makeEngine(store, { random: () => 0.1 })
  const r1 = await e1.execute('demo', body)
  check(r1.status === 200, '权重分支走 m1 → 成功')

  const { engine: e2, calls } = makeEngine(store, { random: () => 0.8 })
  const r2 = await e2.execute('demo', body)
  check(r2.status === 200, '权重分支走 m2 → 成功')
  check(calls[0].url.includes('p2'), 'random=0.8 落到 p2')
}

section('9. 不支持的图结构 → 400 明确报错')
{
  const store = makeStore([
    START('c1'),
    {
      id: 'c1',
      type: 'conditional',
      properties: { conditions: { x: 1 } },
      outputs: {
        true: { elementId: 'END' },
        false: { elementId: 'END' },
      },
    },
    END,
  ])
  const { engine } = makeEngine(store, {})
  const res = await engine.execute('demo', body)
  const text = await res.text()
  check(res.status === 400, 'conditional → 400')
  check(text.includes('请改用 cloud 模式'), '提示改用 cloud')
}

section('10. 边界：路由不存在 / 缺 start / 环')
{
  const { engine: e1 } = makeEngine({ routes: {} }, {})
  let res = await e1.execute('missing', body)
  check(res.status === 400, '路由不存在 → 400')

  const noStartStore = makeStore([modelNode('m1', 'p1', 'a', 'END'), END])
  const { engine: e2 } = makeEngine(noStartStore, {})
  res = await e2.execute('demo', body)
  check(res.status === 400, '缺 start → 400')

  const cycleStore = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'a', 'm2'),
    modelNode('m2', 'p2', 'b', 'm1'),
    END,
  ])
  const { engine: e3 } = makeEngine(cycleStore, { statuses: { p1: 429, p2: 429 } })
  res = await e3.execute('demo', body)
  check(res.status === 500, '存在环 → 500')
}

section('11. 配置问题（缺 provider / 缺凭证）不回退')
{
  const store = makeStore([
    START('m1'),
    modelNode('m1', 'p1', 'a', 'm2'),
    modelNode('m2', 'p2', 'b', 'END'),
    END,
  ])
  const engine = createFallbackEngine({
    loadRoutesStore: () => store,
    fetchFn: async () => sseResponse(200),
    findProvider: () => null,
    readProviderHeaders: () => ({ Authorization: 'k' }),
  })
  const res = await engine.execute('demo', body)
  check(res.status === 400, '节点 provider 缺失 → 400，不继续')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
