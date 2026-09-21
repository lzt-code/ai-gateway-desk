/**
 * LocalBackend 测试 — mock fetch / provider / 凭证：直发、剥离、透传、错误归类
 */

import { createLocalBackend } from '../src/gateway/backends/local.js'

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

function makeFetch(handler) {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fetchFn, calls }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const provider = {
  id: 'fang-zhou',
  type: 'custom-provider',
  base_url: 'https://ark.example.com/',
  pathPrefix: '/api/v3',
}

section('1. 正常直发：URL / headers / body 剥离 / 透传')
{
  const { fetchFn, calls } = makeFetch(
    () =>
      new Response('data: ok\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
  )
  const backend = createLocalBackend({
    fetchFn,
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'Bearer sk-xyz' }),
  })
  const bodyText = JSON.stringify({ model: 'custom-fang-zhou/doubao-seed', messages: [] })
  const res = await backend.chat({ bodyText })
  check(res.status === 200, '200 透传')
  check(
    res.headers.get('Content-Type') === 'text/event-stream',
    '响应头透传（SSE）'
  )
  check((await res.text()) === 'data: ok\n\n', '响应体透传')
  check(calls.length === 1, '仅一次上游请求')
  check(
    calls[0].url === 'https://ark.example.com/api/v3/chat/completions',
    `厂商 URL 正确（实际 ${calls[0].url}）`
  )
  const sent = JSON.parse(calls[0].init.body)
  check(sent.model === 'doubao-seed', 'body.model 已剥离 slug')
  check(
    calls[0].init.headers.get('Authorization') === 'Bearer sk-xyz',
    '注入本地凭证 headers'
  )
}

section('2. 非 2xx 上游响应原样透传')
{
  const { fetchFn } = makeFetch(
    () => new Response(JSON.stringify({ error: { msg: 'rate limited' } }), { status: 429 })
  )
  const backend = createLocalBackend({
    fetchFn,
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'Bearer k' }),
  })
  const res = await backend.chat({
    bodyText: JSON.stringify({ model: 'custom-fang-zhou/m', messages: [] }),
  })
  check(res.status === 429, '429 原样透传')
}

section('3. 错误归类')
{
  const fetchFn = async () => new Response('', { status: 200 })
  const okBackend = createLocalBackend({
    fetchFn: async () => new Response('', { status: 200 }),
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'Bearer k' }),
  })

  let res = await okBackend.chat({ bodyText: 'not-json' })
  check(res.status === 400, '非法 JSON → 400')

  res = await okBackend.chat({ bodyText: JSON.stringify({ model: 'bare-model' }) })
  check(res.status === 400, 'model 无 slug → 400')

  let delegated = null
  const dynamicBackend = createLocalBackend({
    fetchFn,
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'k' }),
    fallbackEngine: {
      async execute(name, body) {
        delegated = { name, body }
        return jsonResponse(200, { ok: true })
      },
    },
  })
  res = await dynamicBackend.chat({
    bodyText: JSON.stringify({ model: 'dynamic/x' }),
  })
  check(res.status === 200, 'dynamic/* 委托 fallback 引擎')
  check(delegated && delegated.name === 'x', '传入路由名 x')
  check(delegated && delegated.body.model === 'dynamic/x', '传入原始 body')

  const noProvider = createLocalBackend({
    fetchFn,
    findProvider: () => null,
    readProviderHeaders: () => ({ Authorization: 'k' }),
  })
  res = await noProvider.chat({
    bodyText: JSON.stringify({ model: 'custom-missing/x' }),
  })
  check(res.status === 400, 'provider 不存在 → 400')

  const noKey = createLocalBackend({
    fetchFn,
    findProvider: () => provider,
    readProviderHeaders: () => null,
  })
  res = await noKey.chat({
    bodyText: JSON.stringify({ model: 'custom-fang-zhou/x' }),
  })
  check(res.status === 400, '本地无凭证 → 400')

  const noEndpoint = createLocalBackend({
    fetchFn,
    findProvider: () => ({ id: 'x', type: 'custom-provider' }),
    readProviderHeaders: () => ({ Authorization: 'k' }),
  })
  res = await noEndpoint.chat({
    bodyText: JSON.stringify({ model: 'custom-x/m' }),
  })
  check(res.status === 400, '缺 base_url → 400')
}

section('4. 网络错误 / 超时 → 502')
{
  const failBackend = createLocalBackend({
    fetchFn: async () => {
      throw new TypeError('fetch failed')
    },
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'k' }),
  })
  let res = await failBackend.chat({
    bodyText: JSON.stringify({ model: 'custom-fang-zhou/x' }),
  })
  check(res.status === 502, '网络异常 → 502')

  const abortBackend = createLocalBackend({
    fetchFn: async (url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    },
    findProvider: () => provider,
    readProviderHeaders: () => ({ Authorization: 'k' }),
    timeoutMs: 20,
  })
  res = await abortBackend.chat({
    bodyText: JSON.stringify({ model: 'custom-fang-zhou/x' }),
  })
  check(res.status === 502, '超时 abort → 502')
}

section('5. health')
{
  const backend = createLocalBackend({})
  const h = await backend.health()
  check(h.type === 'local', 'health 返回 local')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
