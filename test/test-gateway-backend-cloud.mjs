/**
 * CloudBackend 测试 — mock fetch：转发 URL、token 注入/透传、错误归类
 */

import { createCloudBackend } from '../src/gateway/backends/cloud.js'

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
    return handler ? handler(url, init) : new Response('upstream\n', { status: 200 })
  }
  return { fetchFn, calls }
}

section('1. 正常转发：URL / Authorization 透传 / body 透传')
{
  const { fetchFn, calls } = makeFetch()
  const backend = createCloudBackend({
    cloudWorkerUrl: 'https://worker.example.com/',
    fetchFn,
    readGatewayToken: () => 'cfut-local',
  })
  const headers = new Headers({ Authorization: 'Bearer cfut-client' })
  const bodyText = JSON.stringify({ model: 'custom-x/m', messages: [] })
  const res = await backend.chat({ bodyText, headers })
  check(res.status === 200, '200 透传')
  check(
    calls[0].url === 'https://worker.example.com/v1/chat/completions',
    `转发 URL 正确（实际 ${calls[0].url}）`
  )
  check(
    calls[0].init.headers.get('Authorization') === 'Bearer cfut-client',
    '客户端 Authorization 优先透传'
  )
  check(calls[0].init.body === bodyText, 'body 原样透传')
}

section('2. 客户端无 Authorization → 注入本地 cfut token')
{
  const { fetchFn, calls } = makeFetch()
  const backend = createCloudBackend({
    cloudWorkerUrl: 'https://worker.example.com',
    fetchFn,
    readGatewayToken: () => 'cfut-saved',
  })
  await backend.chat({
    bodyText: '{}',
    headers: new Headers(),
  })
  check(
    calls[0].init.headers.get('Authorization') === 'Bearer cfut-saved',
    '注入本地 gateway token'
  )
}

section('3. 配置缺失错误')
{
  const { fetchFn } = makeFetch()

  let backend = createCloudBackend({
    cloudWorkerUrl: '',
    fetchFn,
    readGatewayToken: () => 't',
  })
  let res = await backend.chat({ bodyText: '{}', headers: new Headers() })
  check(res.status === 400, '未配置 cloudWorkerUrl → 400')

  backend = createCloudBackend({
    cloudWorkerUrl: 'not a url',
    fetchFn,
  })
  res = await backend.chat({ bodyText: '{}', headers: new Headers() })
  check(res.status === 400, '非法 cloudWorkerUrl → 400')

  backend = createCloudBackend({
    cloudWorkerUrl: 'https://w.example.com',
    fetchFn,
    readGatewayToken: () => null,
  })
  res = await backend.chat({ bodyText: '{}', headers: new Headers() })
  check(res.status === 400, '客户端无 Authorization 且无本地 token → 400')
}

section('4. 网络错误 / 超时 → 502')
{
  let backend = createCloudBackend({
    cloudWorkerUrl: 'https://w.example.com',
    fetchFn: async () => {
      throw new TypeError('fetch failed')
    },
    readGatewayToken: () => 't',
  })
  let res = await backend.chat({ bodyText: '{}', headers: new Headers() })
  check(res.status === 502, '网络异常 → 502')

  backend = createCloudBackend({
    cloudWorkerUrl: 'https://w.example.com',
    fetchFn: async (url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    },
    readGatewayToken: () => 't',
    timeoutMs: 20,
  })
  res = await backend.chat({ bodyText: '{}', headers: new Headers() })
  check(res.status === 502, '超时 → 502')
}

section('5. health')
{
  const backend = createCloudBackend({ cloudWorkerUrl: 'https://w.example.com' })
  const h = await backend.health()
  check(h.type === 'cloud' && h.configured === true, 'health 返回 cloud/configured')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
