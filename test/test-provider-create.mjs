/**
 * Provider 创建测试（添加 Provider 方案 FP1）
 *
 * 纯逻辑测试：不触网、不启动真实 TUI、不渲染 blessed 屏幕。
 * 覆盖 provider-actions.js 新增的两个导出：
 *   - buildCloudCreateParams：校验 + 参数组装（byok / custom-provider）
 *   - createProviderCloud：按类型分发到云端创建函数（mock 依赖）
 *
 * 测试范式仿照 test-providers-sync.mjs / test-provider-view.mjs：
 * check / section 计数，failures > 0 时 process.exit(1)。
 */

import {
  buildCloudCreateParams,
  createProviderCloud,
} from '../src/tui/provider-actions.js'

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

// ── 测试 1：buildCloudCreateParams — byok 合法 ──
section('测试 1: byok 合法（slug + apiKey，无 name）')
{
  const r = buildCloudCreateParams({ type: 'byok', id: 'openai', apiKey: 'sk-xxx' })
  check(r.ok === true, 'ok = true')
  check(r.name === 'openai', `name 缺省取 slug（实际 ${r.name}）`)
  check(r.slug === 'openai' && r.type === 'byok', 'slug / type 透出')
  check(r.secret === 'sk-xxx', 'secret 透传 apiKey')
  check(!('headers' in r), '无 headers 字段')
}

// ── 测试 2：buildCloudCreateParams — byok 带 name ──
section('测试 2: byok 带 name（alias 透出）')
{
  const r = buildCloudCreateParams({ type: 'byok', id: 'anthropic', name: '  克劳德  ', apiKey: 'sk-a' })
  check(r.ok === true && r.name === '克劳德', 'name 透出且 trim')
}

// ── 测试 3：buildCloudCreateParams — byok 缺 apiKey ──
section('测试 3: byok 缺 apiKey')
{
  const r = buildCloudCreateParams({ type: 'byok', id: 'openai' })
  check(r.ok === false, 'ok = false')
  check(typeof r.reason === 'string' && r.reason.includes('Key'), 'reason 提及 Key')
}

// ── 测试 4：buildCloudCreateParams — 非法 slug ──
section('测试 4: 非法 slug（大写 / 下划线 / 空串 / 前导连字符）')
{
  const bad = ['OpenAI', 'bad_slug', '', '-bad']
  for (const slug of bad) {
    const r = buildCloudCreateParams({ type: 'byok', id: slug, apiKey: 'sk' })
    check(r.ok === false, `slug "${slug}" → ok = false`)
  }
  const good = buildCloudCreateParams({ type: 'byok', id: 'openai', apiKey: 'sk' })
  check(good.ok === true, '合法 slug 仍通过')
}

// ── 测试 5：buildCloudCreateParams — custom 合法，无 apiKey ──
section('测试 5: custom 合法，无 apiKey')
{
  const r = buildCloudCreateParams({ type: 'custom-provider', id: 'custom-agnes', baseUrl: 'https://api.agnes.dev/v1' })
  check(r.ok === true, 'ok = true')
  check(r.baseUrl === 'https://api.agnes.dev/v1' && r.type === 'custom-provider', 'baseUrl / type 透出')
  check(!('headers' in r) && !('secret' in r), '无 headers / secret 字段')
}

// ── 测试 6：buildCloudCreateParams — custom 带 apiKey ──
section('测试 6: custom 带 apiKey → Authorization 头')
{
  const r = buildCloudCreateParams({ type: 'custom-provider', id: 'custom-x', baseUrl: 'http://127.0.0.1:8080', apiKey: 'xxx' })
  check(r.ok === true, 'ok = true')
  check(r.headers && r.headers.Authorization === 'Bearer xxx', 'headers.Authorization = Bearer xxx')
}

// ── 测试 7：buildCloudCreateParams — baseUrl 非 http(s) ──
section('测试 7: baseUrl 非 http(s)')
{
  for (const baseUrl of ['ftp://x', '', 'api.example.com/v1']) {
    const r = buildCloudCreateParams({ type: 'custom-provider', id: 'custom-x', baseUrl })
    check(r.ok === false, `baseUrl "${baseUrl}" → ok = false`)
  }
  const http = buildCloudCreateParams({ type: 'custom-provider', id: 'custom-x', baseUrl: 'http://example.com' })
  check(http.ok === true, 'http:// 前缀通过')
}

// ── 测试 8：buildCloudCreateParams — 非法 type / byok 非法组合 ──
section('测试 8: 非法 type / byok 传 baseUrl、pathPrefix')
{
  for (const type of ['', 'custom', 'BYOK', undefined, null]) {
    const r = buildCloudCreateParams({ type, id: 'x', apiKey: 'sk' })
    check(r.ok === false, `type "${type}" → ok = false`)
  }
  const withBase = buildCloudCreateParams({ type: 'byok', id: 'openai', apiKey: 'sk', baseUrl: 'https://api.openai.com' })
  check(withBase.ok === false, 'byok 传 baseUrl → ok = false')
  const withPrefix = buildCloudCreateParams({ type: 'byok', id: 'openai', apiKey: 'sk', pathPrefix: '/v1' })
  check(withPrefix.ok === false, 'byok 传 pathPrefix → ok = false')
}

// ── 测试 9：createProviderCloud — byok 分发 ──
section('测试 9: createProviderCloud byok 分发')
{
  const calls = []
  const deps = {
    createConfigFn: async (token, accountId, gatewayId, cfg) => {
      calls.push({ token, accountId, gatewayId, cfg })
      return { id: 'cfg-uuid-1', provider_slug: 'openai' }
    },
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'byok', id: 'openai', apiKey: 'sk-xxx' }, deps)
  check(r.ok === true, 'ok = true')
  check(calls.length === 1 && calls[0].cfg.providerSlug === 'openai' && calls[0].cfg.secret === 'sk-xxx' && calls[0].cfg.alias === 'openai', 'createConfigFn 收到 { providerSlug, secret, alias }')
  check(calls[0].token === 't1' && calls[0].accountId === 'acc' && calls[0].gatewayId === 'gw', 'apiToken / accountId / gatewayId 透传')
  check(r.entry.id === 'openai' && r.entry.enabled === true, 'entry.id / enabled 正确')
  check(r.entry.cloudId === 'cfg-uuid-1', 'entry.cloudId 取云端返回 id')
}

// ── 测试 10：createProviderCloud — custom 分发 ──
section('测试 10: createProviderCloud custom 分发')
{
  const calls = []
  const deps = {
    createCustomFn: async (token, accountId, cfg) => {
      calls.push({ token, accountId, cfg })
      return { id: 'cp-uuid-1', slug: 'custom-agnes' }
    },
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'custom-provider', id: 'custom-agnes', baseUrl: 'https://api.agnes.dev', apiKey: 'k1', name: 'Agnes' }, deps)
  check(r.ok === true, 'ok = true')
  check(calls.length === 1, 'createCustomFn 被调用一次')
  check(calls[0].cfg.name === 'Agnes' && calls[0].cfg.slug === 'custom-agnes' && calls[0].cfg.baseUrl === 'https://api.agnes.dev', 'createCustomFn 收到 name / slug / baseUrl')
  check(calls[0].cfg.headers && calls[0].cfg.headers.Authorization === 'Bearer k1' && calls[0].cfg.enable === true, '收到 headers / enable: true')
  check(calls[0].token === 't1' && calls[0].accountId === 'acc', 'apiToken / accountId 透传')
  check(r.entry.type === 'custom-provider' && r.entry.cloudId === 'cp-uuid-1', 'entry.type / cloudId 正确')
  check(r.entry.base_url === 'https://api.agnes.dev', 'entry.base_url 同步自定义 baseUrl')
}

// ── 测试 10b：createProviderCloud — custom 无 baseUrl 时 entry 无 base_url ──
section('测试 10b: createProviderCloud custom entry 无 base_url 守卫')
{
  const calls = []
  const deps = {
    createCustomFn: async (token, accountId, cfg) => {
      calls.push({ token, accountId, cfg })
      return { id: 'cp-uuid-2', slug: 'custom-x' }
    },
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'custom-provider', id: 'custom-x', baseUrl: 'https://x.dev' }, deps)
  check(r.ok === true && r.entry && r.entry.base_url === 'https://x.dev', 'entry.base_url 存在')
  const byok = await createProviderCloud('t1', 'acc', 'gw', { type: 'byok', id: 'openai', apiKey: 'sk' }, { createConfigFn: async () => ({ id: 'u' }) })
  check(byok.ok === true && !('base_url' in byok.entry), 'byok entry 无 base_url 字段')
}

// ── 测试 11：createProviderCloud — 校验失败不触网 ──
section('测试 11: 校验失败不触网')
{
  let called = false
  const deps = {
    createConfigFn: async () => { called = true },
    createCustomFn: async () => { called = true },
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'byok', id: 'openai' }, deps)
  check(r.ok === false && r.reason && r.reason.includes('Key'), '透传 reason')
  check(called === false, '云端函数未被调用')
}

// ── 测试 12：createProviderCloud — 云端抛错 ──
section('测试 12: 云端抛错 → { ok:false, error }')
{
  const deps = {
    createConfigFn: async () => { throw new Error('boom') },
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'byok', id: 'openai', apiKey: 'sk' }, deps)
  check(r.ok === false && r.error && r.error.message === 'boom', '捕获 Error 对象，不抛出')
}

// ── 测试 13：createProviderCloud — 返回结果无 id ──
section('测试 13: 云端未返回 id → cloudId undefined')
{
  const deps = {
    createConfigFn: async () => ({ provider_slug: 'openai' }),
  }
  const r = await createProviderCloud('t1', 'acc', 'gw', { type: 'byok', id: 'openai', apiKey: 'sk' }, deps)
  check(r.ok === true, '仍 ok = true')
  check(r.entry.cloudId === undefined, 'entry.cloudId === undefined')
}

console.log(`\n${checks} 项断言，失败 ${failures} 项`)
if (failures > 0) {
  console.log('存在失败项')
  process.exit(1)
}
console.log('全部通过 ✓')
process.exit(0)
