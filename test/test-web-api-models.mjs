/**
 * 任务 26 验证脚本：模型管理 API 端点（内存 stateStore 注入）
 *
 * 覆盖：8 个 API 端点（GET /api/state、toggle/remove/batch-toggle/edit/add、
 * filtered、providers/list）+ 变更落盘/只读不落盘 + editModelMetadata 纯函数
 * + 任务 25 静态文件回归。全程注入内存 stateStore，绝不触碰真实 data/ 文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../src/web/server.js'
import { editModelMetadata } from '../src/tui/actions.js'

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

// 内存 store fixture（每个 section 重新创建，保证隔离）
function makeStore(initial = {}) {
  const saves = []
  const store = {
    state: structuredClone(initial),
    saves, // 记录每次 save 收到的参数引用
    load: () => store.state,
    save: (s) => {
      store.saves.push(s)
    },
  }
  return store
}

// 标准样例 state（与交付包 §4.1 一致）
const sampleState = {
  'openrouter/deepseek-r1': {
    status: 'selected',
    metadata: { provider: 'openrouter', name: 'DeepSeek R1', context_length: 65536 },
  },
  'openrouter/gpt-4o': {
    status: 'hidden',
    metadata: { provider: 'openrouter', name: 'GPT-4o' },
  },
  'custom-agnes/agnes': {
    status: 'selected',
    provider: 'custom-agnes',
    metadata: { name: 'Agnes', context_length: 128000 },
  },
}

// 快捷：注入内存 store 的 app + req helper
function makeApp(initial = sampleState, configStore) {
  const store = makeStore(initial)
  const app = createApp({ stateStore: store, configStore })
  const req = (method, p, body) =>
    app.request(p, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
  return { app, store, req }
}

// ── 测试 1：GET /api/state ──
section('测试 1: GET /api/state')
{
  const { app } = makeApp()
  const res = await app.request('/api/state')
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.ok === true, 'ok === true')
  check(JSON.stringify(body.state) === JSON.stringify(sampleState), 'state 深等于初始 state')
}

// ── 测试 2-5：POST /api/models/toggle ──
section('测试 2: toggle — selected → hidden')
{
  const { app, req } = makeApp()
  const res = await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.changed === true, 'changed === true')
  check(body.entry.status === 'hidden', 'entry.status === hidden')
  const stateBody = await (await app.request('/api/state')).json()
  check(stateBody.state['openrouter/deepseek-r1'].status === 'hidden', 'GET /api/state 确认已变')
}

section('测试 3: toggle — hidden → selected')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/toggle', { modelId: 'openrouter/gpt-4o' })
  const body = await res.json()
  check(body.changed === true, 'changed === true')
  check(body.entry.status === 'selected', 'entry.status === selected')
}

section('测试 4: toggle — 模型不存在')
{
  const { app, store, req } = makeApp()
  const res = await req('POST', '/api/models/toggle', { modelId: 'nope/x' })
  const body = await res.json()
  check(res.status === 404, '返回 404')
  check(body.error === 'model not found', 'error === model not found')
  check(store.saves.length === 0, '未触发 save')
  check(JSON.stringify(store.state) === JSON.stringify(sampleState), 'state 未变')
}

section('测试 5: toggle — 缺 modelId')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/toggle', {})
  const body = await res.json()
  check(res.status === 400, '返回 400')
  check(body.error.includes('modelId'), 'error 含 modelId')
}

// ── 测试 6-8：POST /api/models/remove ──
section('测试 6: remove — 一次性永久删除')
{
  const { app, req } = makeApp()
  const res = await req('POST', '/api/models/remove', { modelId: 'openrouter/gpt-4o' })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.changed === true, 'changed === true')
  check(body.entry === null, 'entry === null（已永久删除）')
  const stateBody = await (await app.request('/api/state')).json()
  check(!('openrouter/gpt-4o' in stateBody.state), 'GET /api/state 已无此键')
}

section('测试 7: remove — 再次删除已删除的模型')
{
  const { app, req } = makeApp()
  await req('POST', '/api/models/remove', { modelId: 'openrouter/gpt-4o' })
  const res2 = await req('POST', '/api/models/remove', { modelId: 'openrouter/gpt-4o' })
  const body2 = await res2.json()
  check(res2.status === 404, '返回 404')
  check(body2.error === 'model not found', 'error === model not found')
}

section('测试 8: remove — 模型不存在')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/remove', { modelId: 'nope/x' })
  const body = await res.json()
  check(res.status === 404, '返回 404')
  check(body.error === 'model not found', 'error === model not found')
}

// ── 测试 9-12：POST /api/models/batch-toggle ──
section('测试 9: batch-toggle — 指定 modelIds')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/batch-toggle', { modelIds: ['openrouter/gpt-4o'] })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.count === 1, 'count === 1')
  check(body.status === 'selected', 'status === selected（gpt-4o 从 hidden 变 selected）')
  check(body.changed === true, 'changed === true')
}

section('测试 10: batch-toggle — 全量')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/batch-toggle', {})
  const body = await res.json()
  check(body.count === 3, 'count === 3（全部）')
  check(body.status === 'hidden', '有 selected → status === hidden')
}

section('测试 12: batch-toggle — modelIds 非数组')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/batch-toggle', { modelIds: 'x' })
  const body = await res.json()
  check(res.status === 400, '返回 400')
  check(body.error.includes('modelIds'), 'error 含 modelIds')
}

// ── 测试 12b-12e：POST /api/models/batch-remove ──
section('测试 12b: batch-remove — 指定 modelIds')
{
  const { app, store, req } = makeApp()
  const res = await req('POST', '/api/models/batch-remove', { modelIds: ['openrouter/gpt-4o', 'openrouter/deepseek-r1'] })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.changed === true, 'changed === true')
  check(body.count === 2, 'count === 2')
  const stateBody = await (await app.request('/api/state')).json()
  check(!('openrouter/gpt-4o' in stateBody.state), 'gpt-4o 已删除')
  check(!('openrouter/deepseek-r1' in stateBody.state), 'deepseek-r1 已删除')
  check('custom-agnes/agnes' in stateBody.state, '未指定的模型保留')
}

section('测试 12c: batch-remove — 全量')
{
  const { app, req } = makeApp()
  const res = await req('POST', '/api/models/batch-remove', {})
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.changed === true, 'changed === true')
  check(body.count === 3, 'count === 3（全部删除）')
  const stateBody = await (await app.request('/api/state')).json()
  check(Object.keys(stateBody.state).length === 0, 'state 已空')
}

section('测试 12d: batch-remove — 空 range')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/batch-remove', { modelIds: [] })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.changed === false, 'changed === false')
  check(body.count === 0, 'count === 0')
}

section('测试 12e: batch-remove — modelIds 非数组')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/batch-remove', { modelIds: 'x' })
  const body = await res.json()
  check(res.status === 400, '返回 400')
  check(body.error.includes('modelIds'), 'error 含 modelIds')
}

// ── 测试 13-17：POST /api/models/edit ──
section('测试 13: edit — name + context_length + max_output_length 数字转换')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', {
    modelId: 'openrouter/deepseek-r1',
    fields: { name: 'R1 Pro', context_length: '131072', max_output_length: '4096' },
  })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.metadata.name === 'R1 Pro', 'metadata.name === R1 Pro')
  check(body.metadata.context_length === 131072 && typeof body.metadata.context_length === 'number',
    'context_length 字符串 "131072" → 数字 131072')
  check(body.metadata.max_output_length === 4096 && typeof body.metadata.max_output_length === 'number',
    'max_output_length 字符串 "4096" → 数字 4096')
}

section('测试 14: edit — 留空不覆盖')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', {
    modelId: 'openrouter/deepseek-r1',
    fields: { name: '', description: '' },
  })
  const body = await res.json()
  check(body.metadata.name === 'DeepSeek R1', 'name 保持原值')
  check(!('description' in body.metadata), 'description 空字符串不新增')
}

section('测试 15: edit — context_length 0 合法')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', {
    modelId: 'openrouter/deepseek-r1',
    fields: { context_length: '0' },
  })
  const body = await res.json()
  check(body.metadata.context_length === 0, 'context_length === 0（"0" 是合法值）')
}

section('测试 15a: edit — max_output_length 0 合法')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', {
    modelId: 'openrouter/deepseek-r1',
    fields: { max_output_length: '0' },
  })
  const body = await res.json()
  check(body.metadata.max_output_length === 0, 'max_output_length === 0（"0" 是合法值）')
}

section('测试 16: edit — 模型不存在')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', { modelId: 'nope/x', fields: { name: 'x' } })
  const body = await res.json()
  check(res.status === 404, '返回 404')
  check(body.error === 'model not found', 'error === model not found')
}

section('测试 17: edit — 缺 fields')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/edit', { modelId: 'openrouter/gpt-4o' })
  const body = await res.json()
  check(res.status === 400, '返回 400')
  check(body.error.includes('fields'), 'error 含 fields')
}

// ── 测试 18-19：POST /api/models/add ──
section('测试 18: add — 新模型')
{
  const { app, req } = makeApp()
  const res = await req('POST', '/api/models/add', {
    modelId: 'openrouter/claude-3-5-sonnet',
    provider: 'openrouter',
    metadata: { name: 'Claude 3.5' },
  })
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.entry.status === 'selected', 'entry.status === selected')
  check(body.entry.provider === 'openrouter', 'entry.provider === openrouter')
  const stateBody = await (await app.request('/api/state')).json()
  check('openrouter/claude-3-5-sonnet' in stateBody.state, 'GET /api/state 含新键')
}

section('测试 19: add — 缺 provider')
{
  const { req } = makeApp()
  const res = await req('POST', '/api/models/add', { modelId: 'x' })
  const body = await res.json()
  check(res.status === 400, '返回 400')
  check(body.error.includes('provider'), 'error 含 provider')
}

// ── 测试 20-21：GET /api/models/filtered ──
section('测试 20: filtered — provider + keyword 组合')
{
  const { app } = makeApp()
  const res = await app.request('/api/models/filtered?provider=openrouter&keyword=deep')
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.count === 1, 'count === 1')
  check(body.items[0].modelId === 'openrouter/deepseek-r1', '命中 deepseek-r1')
}

section('测试 21: filtered — 无参（全部）')
{
  const { app } = makeApp()
  const res = await app.request('/api/models/filtered')
  const body = await res.json()
  check(body.count === 3, 'count === 3（全部）')
}

section('测试 21b: filtered — status 筛选')
{
  const { app } = makeApp()
  const res = await app.request('/api/models/filtered?status=selected')
  const body = await res.json()
  check(res.status === 200, '返回 200')
  check(body.count === 2, 'status=selected → count === 2')
  check(body.items.every((it) => it.entry.status === 'selected'), '所有项 status === selected')
}
{
  const { app } = makeApp()
  const res = await app.request('/api/models/filtered?status=hidden')
  const body = await res.json()
  check(body.count === 1, 'status=hidden → count === 1')
  check(body.items[0].modelId === 'openrouter/gpt-4o', '命中 gpt-4o')
}
{
  const { app } = makeApp()
  const res = await app.request('/api/models/filtered?provider=openrouter&status=selected')
  const body = await res.json()
  check(body.count === 1, 'provider+status 组合 → 1 项')
  check(body.items[0].modelId === 'openrouter/deepseek-r1', '命中 deepseek-r1')
}

// ── 测试 22：GET /api/providers/list ──
section('测试 22: providers/list')
{
  const mockConfigStore = {
    load: () => ({
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
      kv: { namespaceId: 'ns', key: 'models' },
      providers: [
        { id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
        { id: 'openrouter', name: 'default', type: 'byok', enabled: true },
      ],
    }),
  }
  const { app } = makeApp(sampleState, mockConfigStore)
  const res = await app.request('/api/providers/list')
  const body = await res.json()
  check(JSON.stringify(body.providers) === JSON.stringify([
    { id: 'custom-agnes', name: 'Agnes' },
    // Cloudflare 将「未设置别名」的 BYOK provider 返回 alias: "default"，
    // 服务端防御性将其替换为 slug，确保侧栏显示有意义的标识符
    { id: 'openrouter', name: 'openrouter' },
  ]), 'providers 列表：custom-agnes(Agnes), openrouter(openrouter)')
}
// ── 测试 22b：隐藏 provider 不出现于侧栏，其模型也不返回 ──
section('测试 22b: 隐藏 provider 过滤')
{
  const mockConfigStore = {
    load: () => ({
      gateway: { host: 'gateway.ai.cloudflare.com', accountId: 'acc', gatewayId: 'gw' },
      kv: { namespaceId: 'ns', key: 'models' },
      providers: [
        { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
        { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: false }, // 隐藏
      ],
    }),
  }
  const { app } = makeApp({
    'openrouter/gpt-4o': { status: 'selected', provider: 'openrouter', metadata: { id: 'openrouter/gpt-4o' } },
    'custom-agnes/agnes': { status: 'selected', provider: 'custom-agnes', metadata: { id: 'custom-agnes/agnes' } },
  }, mockConfigStore)
  const list = await (await app.request('/api/providers/list')).json()
  check(
    list.providers.every((p) => p.id !== 'openrouter'),
    'providers/list 不含隐藏的 openrouter',
  )
  const filt = await (await app.request('/api/models/filtered')).json()
  check(
    filt.items.every((it) => it.modelId !== 'openrouter/gpt-4o') &&
      filt.items.some((it) => it.modelId === 'custom-agnes/agnes'),
    'filtered 不含隐藏 provider 的模型，仍含可见 provider 的模型',
  )
}


// ── 测试 23：变更落盘验证 ──
section('测试 23: 变更端点触发 save')
{
  const { store, req } = makeApp()
  await req('POST', '/api/models/toggle', { modelId: 'openrouter/deepseek-r1' })
  check(store.saves.length === 1, 'POST 后 saves.length === 1')
  check(store.saves[0] === store.state, 'saves[0] 引用 === 当前 state（同一对象）')
}

// ── 测试 24：只读端点不落盘 ──
section('测试 24: 只读端点不触发 save')
{
  const { app, store } = makeApp()
  await app.request('/api/state')
  await app.request('/api/models/filtered')
  await app.request('/api/providers/list')
  check(store.saves.length === 0, 'GET 端点后 saves.length === 0')
}

// ── 测试 25：editModelMetadata 纯函数（直接调用，不经 HTTP）──
section('测试 25: editModelMetadata 纯函数')
{
  const state = structuredClone(sampleState)
  const changed = editModelMetadata(state, 'openrouter/deepseek-r1', { name: 'R1 Pro' })
  check(changed === true, '有字段生效 → true')
  check(state['openrouter/deepseek-r1'].metadata.name === 'R1 Pro', '原地修改 state')

  const changed2 = editModelMetadata(state, 'nope/x', { name: 'x' })
  check(changed2 === false, '模型不存在 → false')

  const changed3 = editModelMetadata(state, 'openrouter/deepseek-r1', {})
  check(changed3 === false, '空 fields → false')

  const changed4 = editModelMetadata(state, 'openrouter/deepseek-r1', { context_length: 'abc' })
  check(changed4 === false, 'NaN context_length → false 不覆盖')
  check(state['openrouter/deepseek-r1'].metadata.context_length === 65536, 'NaN 时保留原值')

  const changed5 = editModelMetadata(state, 'openrouter/deepseek-r1', { max_output_length: '8192' })
  check(changed5 === true, 'max_output_length 生效 → true')
  check(state['openrouter/deepseek-r1'].metadata.max_output_length === 8192, 'max_output_length 写入 8192')

  const changed6 = editModelMetadata(state, 'openrouter/deepseek-r1', { max_output_length: 'abc' })
  check(changed6 === false, 'NaN max_output_length → false 不覆盖')
  check(state['openrouter/deepseek-r1'].metadata.max_output_length === 8192, 'NaN 时保留原值 8192')
}

// ── 测试 26：任务 25 回归（静态文件 + health 不受影响）──
section('测试 26: 任务 25 回归')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-webapi-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>ai-gateway-desk placeholder</h1>')
  const app = createApp({ publicDir: dir, stateStore: makeStore() })
  const res = await app.request('/')
  check(res.status === 200, '根路径返回 200')
  check((await res.text()).includes('placeholder'), '返回注入的占位页内容')
  const resHealth = await app.request('/api/health')
  check(resHealth.status === 200 && (await resHealth.json()).ok === true, '/api/health 仍 200')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
