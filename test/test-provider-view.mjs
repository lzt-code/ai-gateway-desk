/**
 * Provider 管理视图测试（任务 20）
 *
 * 纯逻辑测试：不触网、不启动真实 TUI、不渲染 blessed 屏幕。
 * 覆盖：
 *   - provider-actions.js：mergeProviderViews / followDelete / setLocalEnabled /
 *     setLocalName / buildCloudUpdateParams / updateProviderCloud（mock 依赖）/
 *     buildCloudDeleteParams / deleteProviderCloud（mock 依赖）/ writeProvidersConfigFile（mock fs）
 *   - api.js：updateCustomProvider / updateProviderConfig / deleteCustomProvider /
 *     deleteProviderConfig（mock fetch）
 *   - views.js：buildProviderItems（列表项渲染）
 *
 * 场景（任务 20 测试方法）：
 *   A: 合并展示——云端新增标 [新增]、本地已有保留本地 enabled、本地缺失标 [云端已删]
 *   B: 云端拉取不完整（errors 非空）→ 不标 [云端已删]
 *   C: 跟随删除——对 [云端已删] 条目执行本地移除 → 返回新数组，原数组不变
 *   D: 编辑结果组装——name 修改 / api key 留空 / enabled 切换 → 生成正确的云端调用参数
 *   F: 删除编排——custom 用 cloudId（UUID）/ byok 用 slug；缺 cloudId 不触网；云端抛错透出
 *   E: 离线降级——拉取失败时返回 { readonly: true, providers: 本地缓存 }
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import {
  mergeProviderViews,
  followDelete,
  setLocalEnabled,
  setLocalName,
  setLocalBaseUrl,
  buildCloudUpdateParams,
  updateProviderCloud,
  buildCloudDeleteParams,
  deleteProviderCloud,
  writeProvidersConfigFile,
} from '../src/tui/provider-actions.js'
import { updateCustomProvider, updateProviderConfig, deleteCustomProvider, deleteProviderConfig, createCustomProvider } from '../src/cloudflare/api.js'
import { buildProviderItems } from '../src/tui/render.js'

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

// ── 测试数据（任务 20 数据样例）──
const localProviders = [
  { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: false },
  { id: 'custom-old', name: 'Old', type: 'custom-provider', enabled: true },
]

const cloudResult = {
  providers: [
    { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: true },
    { id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true },
  ],
  errors: [],
}

// ── 测试 1：模块导出 ──
section('测试 1: 导出')
for (const fn of [
  ['mergeProviderViews', mergeProviderViews],
  ['followDelete', followDelete],
  ['setLocalEnabled', setLocalEnabled],
  ['setLocalName', setLocalName],
  ['setLocalBaseUrl', setLocalBaseUrl],
  ['buildCloudUpdateParams', buildCloudUpdateParams],
  ['updateProviderCloud', updateProviderCloud],
  ['buildCloudDeleteParams', buildCloudDeleteParams],
  ['deleteProviderCloud', deleteProviderCloud],
  ['writeProvidersConfigFile', writeProvidersConfigFile],
  ['updateCustomProvider', updateCustomProvider],
  ['updateProviderConfig', updateProviderConfig],
  ['deleteCustomProvider', deleteCustomProvider],
  ['deleteProviderConfig', deleteProviderConfig],
  ['buildProviderItems', buildProviderItems],
]) {
  check(typeof fn[1] === 'function', `${fn[0]} 已导出`)
}

// ── 测试 2：场景 A — 合并展示（新增 / 保留本地 enabled / 云端已删）──
section('测试 2: 场景 A — mergeProviderViews 完整同步')
{
  const merged = mergeProviderViews(localProviders, cloudResult)
  const byId = new Map(merged.providers.map((p) => [p.id, p]))
  check(merged.readonly === false, 'readonly = false（云端同步成功）')
  check(merged.providers.length === 3, `3 个条目（本地 2 + 云端新增 1，实际 ${merged.providers.length}）`)

  // a. 云端有、本地没有 → [新增]
  const agnes = byId.get('custom-agnes')
  check(agnes && agnes.mark === 'new', 'custom-agnes 标记 [新增]')
  check(agnes && agnes.enabled === true, 'custom-agnes enabled 默认 true')

  // b. 两边都有 → 保留本地 enabled，name 取云端
  const openrouter = byId.get('openrouter')
  check(openrouter && openrouter.mark === null, 'openrouter 无标记（两边都有）')
  check(openrouter && openrouter.enabled === false, 'openrouter 保留本地 enabled=false')

  // c. 本地有、云端没有 → [云端已删]（拉取完整时）
  const old = byId.get('custom-old')
  check(old && old.mark === 'removed', 'custom-old 标记 [云端已删]')
  check(old && old.enabled === true, 'custom-old 保留本地条目')

  // 不修改入参
  check(localProviders.length === 2, '原 localProviders 未被修改')
  check(cloudResult.providers.length === 2, '原 cloudResult 未被修改')
}

// ── 测试 3：场景 B — 云端拉取不完整（errors 非空）→ 不标 [云端已删] ──
section('测试 3: 场景 B — errors 抑制 removed')
{
  const partial = { providers: cloudResult.providers, errors: [{ source: 'provider_configs', error: new Error('boom') }] }
  const merged = mergeProviderViews(localProviders, partial)
  const ids = merged.providers.map((p) => p.id)
  check(!ids.includes('custom-old'), '本地独有条目不标 [云端已删]（errors 非空）')
  check(ids.includes('custom-agnes'), '云端新增仍标 [新增]')
  check(merged.providers.some((p) => p.id === 'custom-agnes' && p.mark === 'new'), '新增标记不受 errors 影响')
}

// ── 测试 4：场景 E — 离线降级（cloudResult 为 null）──
section('测试 4: 场景 E — 离线降级')
{
  const merged = mergeProviderViews(localProviders, null)
  check(merged.readonly === true, 'readonly = true（拉取失败）')
  check(merged.providers.length === 2, '展示本地缓存（2 项）')
  check(merged.providers.every((p) => p.mark === null), '缓存条目无 [新增]/[云端已删] 标记')
  const bad = mergeProviderViews(localProviders, { providers: 'oops' })
  check(bad.readonly === true, 'cloudResult.providers 非数组 → 只读降级')
}

// ── 测试 5：场景 C — 跟随删除（纯函数，原数组不变）──
section('测试 5: 场景 C — followDelete / setLocalEnabled / setLocalName')
{
  const result = followDelete(localProviders, 'custom-old')
  check(result.length === 1 && result[0].id === 'openrouter', '跟随删除 → 仅剩 openrouter')
  check(localProviders.length === 2, '原数组不变')

  const disabled = setLocalEnabled(localProviders, 'openrouter', true)
  check(disabled.find((p) => p.id === 'openrouter').enabled === true, 'setLocalEnabled 生效')
  check(disabled.find((p) => p.id === 'custom-old').enabled === true, '其他条目不变')
  check(localProviders.find((p) => p.id === 'openrouter').enabled === false, '原数组不变（enabled）')

  const renamed = setLocalName(localProviders, 'openrouter', 'NewName')
  check(renamed.find((p) => p.id === 'openrouter').name === 'NewName', 'setLocalName 生效')
  check(localProviders.find((p) => p.id === 'openrouter').name === 'OpenRouter', '原数组不变（name）')

  const rebased = setLocalBaseUrl(localProviders, 'custom-old', 'https://new.example.com')
  check(rebased.find((p) => p.id === 'custom-old').base_url === 'https://new.example.com', 'setLocalBaseUrl 生效')
  check(localProviders.find((p) => p.id === 'custom-old').base_url === undefined, '原数组不变（base_url）')
  const noMatch = setLocalBaseUrl(localProviders, '不存在', 'https://x.com')
  check(noMatch.every((p) => !p.base_url), 'setLocalBaseUrl 无匹配 → 原样返回')

  check(followDelete(localProviders, '不存在').length === 2, '删除不存在的 id → 原样返回')
}

// ── 测试 6：场景 D — 编辑结果组装（buildCloudUpdateParams）──
section('测试 6: 场景 D — buildCloudUpdateParams')
{
  // custom-provider：name 修改（更新路径需 cloudId UUID，非 slug）
  const custom = { id: 'custom-agnes', cloudId: '00000000-0000-4000-8000-000000000001', name: 'Agnes', type: 'custom-provider' }
  const r1 = buildCloudUpdateParams(custom, { name: '新名字', apiKey: null })
  check(r1.ok === true, 'custom name 修改 → ok')
  check(r1.params.kind === 'custom-provider' && r1.params.body.name === '新名字', 'PATCH body 含 name')
  check(r1.params.id === '00000000-0000-4000-8000-000000000001', 'custom 更新路径用 cloudId（UUID）而非 slug')
  check(!('enable' in r1.params.body), '未变更字段不提交（云端 enable 不再管控）')

  // custom-provider：仅传已移除的 cloudEnabled → 无云端变更
  const r2 = buildCloudUpdateParams(custom, { name: null, apiKey: null })
  check(r2.ok === false && r2.unsupported.includes('无云端变更'), '无 name/apiKey → 无云端变更')

  // custom-provider：api key → 转换为 headers
  const r3 = buildCloudUpdateParams(custom, { name: null, apiKey: 'sk-xxx' })
  check(r3.ok === true && r3.params.body.headers.Authorization === 'Bearer sk-xxx', 'custom api key → headers.Authorization')
  check(r3.params.id === custom.cloudId, 'custom 覆盖 key 路径用 cloudId（UUID）')

  // custom-provider：缺 cloudId（本地缓存/旧数据）→ 提示刷新
  const r3b = buildCloudUpdateParams({ id: 'custom-agnes', name: 'Agnes', type: 'custom-provider' }, { name: 'x', apiKey: null })
  check(r3b.ok === false && r3b.unsupported.includes('刷新'), 'custom 缺 cloudId → 提示先刷新')

  // custom-provider：baseUrl 修改 → PATCH body 含 baseUrl（updateCustomProvider 映射 base_url）
  const r3c = buildCloudUpdateParams(custom, { name: null, apiKey: null, baseUrl: 'https://new.example.com' })
  check(r3c.ok === true && r3c.params.body.baseUrl === 'https://new.example.com', 'custom baseUrl → body.baseUrl 透传')
  check(r3c.params.kind === 'custom-provider' && r3c.params.id === custom.cloudId, 'custom baseUrl 路径仍用 cloudId（UUID）')

  // custom-provider：仅 baseUrl → ok（不再是「无云端变更」）
  const r3d = buildCloudUpdateParams(custom, { name: null, apiKey: null, baseUrl: 'https://new.example.com' })
  check(r3d.ok === true, 'custom 仅 baseUrl → ok（非无云端变更）')

  // byok：api key 覆盖（可同时改名）
  const byok = { id: 'openrouter', cloudId: '00000000-0000-4000-8000-000000000002', name: 'OpenRouter', type: 'byok' }
  const r4 = buildCloudUpdateParams(byok, { name: '新名', apiKey: 'sk-new' })
  check(r4.ok === true && r4.params.kind === 'byok', 'byok api key 覆盖 → ok')
  check(r4.params.id === '00000000-0000-4000-8000-000000000002', 'byok 更新路径用 cloudId（UUID）而非 slug')
  check(r4.params.slug === 'openrouter', 'byok 保留 slug 供 body provider_slug')
  check(r4.params.body.secret === 'sk-new' && r4.params.body.alias === '新名', 'PUT body { secret, alias }')
  const r5 = buildCloudUpdateParams(byok, { name: null, apiKey: 'sk-new' })
  check(r5.ok === true && !('alias' in r5.params.body), '未改 name → 不提交 alias')

  // byok：仅改名（无新 key）→ 不支持
  const r6 = buildCloudUpdateParams(byok, { name: '新名', apiKey: null })
  check(r6.ok === false && r6.unsupported.includes('新 Key'), 'byok 单独改名 → unsupported（需同时提供新 Key）')

  // byok：传 baseUrl → 不支持（官方厂商路径固定）
  const r6b = buildCloudUpdateParams(byok, { name: null, apiKey: 'sk', baseUrl: 'https://x.com' })
  check(r6b.ok === false && r6b.unsupported.includes('Base URL'), 'byok 传 baseUrl → unsupported（含 Base URL）')

  // byok：缺 cloudId → 提示刷新
  const r7 = buildCloudUpdateParams({ id: 'openrouter', name: 'OpenRouter', type: 'byok' }, { name: null, apiKey: 'sk' })
  check(r7.ok === false && r7.unsupported.includes('刷新'), 'byok 缺 cloudId → 提示先刷新')

  // 无任何变更
  const r8 = buildCloudUpdateParams(custom, { name: null, apiKey: null })
  check(r8.ok === false && r8.unsupported.includes('无云端变更'), '无变更 → unsupported')
}

// ── 测试 7：updateProviderCloud 编排（mock 依赖）──
section('测试 7: updateProviderCloud 编排')
{
  const calls = []
  const deps = {
    updateCustomFn: async (token, accountId, id, body) => { calls.push({ kind: 'custom', token, accountId, id, body }); return { id } },
    updateConfigFn: async (token, accountId, gatewayId, id, body) => { calls.push({ kind: 'byok', token, accountId, gatewayId, id, body }); return { id } },
  }

  // custom → updateCustomFn（cloudId UUID）
  const r1 = await updateProviderCloud('t1', 'acc', 'gw', { id: 'cp-1', cloudId: 'u1', type: 'custom-provider' }, { name: 'n', apiKey: null }, deps)
  check(r1.ok === true && r1.result.id === 'u1', 'custom 更新成功')
  check(calls.length === 1 && calls[0].kind === 'custom' && calls[0].id === 'u1' && calls[0].token === 't1', 'updateCustomFn 路径用 cloudId（UUID）')


  // byok → updateConfigFn（cloudId UUID + body.providerSlug）
  calls.length = 0
  const r2 = await updateProviderCloud('t2', 'acc', 'gw', { id: 'openrouter', cloudId: 'u2', type: 'byok' }, { name: null, apiKey: 'sk' }, deps)
  check(r2.ok === true && calls.length === 1 && calls[0].kind === 'byok' && calls[0].id === 'u2' && calls[0].gatewayId === 'gw', 'updateConfigFn 路径用 cloudId（UUID）+ gatewayId')
  check(calls[0].body.secret === 'sk' && calls[0].body.providerSlug === 'openrouter', 'body 含 secret + providerSlug（slug 仅用于 body）')

  // unsupported → 不调用任何云端函数
  calls.length = 0
  const r3 = await updateProviderCloud('t3', 'acc', 'gw', { id: 'openrouter', cloudId: 'u2', type: 'byok' }, { name: 'n', apiKey: null }, deps)
  check(r3.ok === false && r3.unsupported && calls.length === 0, 'unsupported 不调用云端')

  // 缺 cloudId → 不触网，提示刷新（云端端点需 UUID 而非 slug）
  calls.length = 0
  const r3b = await updateProviderCloud('t3', 'acc', 'gw', { id: 'cp-1', type: 'custom-provider' }, { name: 'n', apiKey: null }, deps)
  check(r3b.ok === false && r3b.unsupported.includes('刷新') && calls.length === 0, '缺 cloudId → 不触网提示刷新')

  // 云端抛错 → { ok:false, error }
  calls.length = 0
  const failingDeps = { ...deps, updateCustomFn: async () => { throw new Error('boom') } }
  const r4 = await updateProviderCloud('t4', 'acc', 'gw', { id: 'cp-1', cloudId: 'u1', type: 'custom-provider' }, { name: 'n', apiKey: null }, failingDeps)
  check(r4.ok === false && r4.error && r4.error.message === 'boom', '云端抛错 → { ok:false, error }')
}

// ── 测试 8：writeProvidersConfigFile（mock fs 依赖）──
{
  const written = {}
  const deps = {
    existsSync: (p) => p === '/cfg/providers.json',
    readFileSync: (p) => {
      if (p === '/cfg/providers.json') return JSON.stringify({ gateway: { accountId: 'acc' }, kv: { namespaceId: 'ns' }, providers: [{ id: 'old' }] })
      if (p === '/cfg/providers.json.bak') return 'backup-content'
      throw new Error('unexpected read: ' + p)
    },
    writeFileSync: (p, content) => { written[p] = content },
    configPath: '/cfg/providers.json',
    backupPath: '/cfg/providers.json.bak',
  }
  const result = writeProvidersConfigFile([{ id: 'openrouter' }], deps)
  check(result.backupPath === '/cfg/providers.json.bak', '返回备份路径')
  const parsed = JSON.parse(written['/cfg/providers.json'])
  check(parsed.providers.length === 1 && parsed.providers[0].id === 'openrouter', 'providers 数组已替换')
  check(parsed.gateway.accountId === 'acc' && parsed.kv.namespaceId === 'ns', 'gateway / kv 原样保留')
  check(written['/cfg/providers.json.bak'] !== undefined, '写前已备份')

  // 原文件不存在 → 不备份，写最小结构
  const written2 = {}
  const deps2 = {
    existsSync: () => false,
    writeFileSync: (p, c) => { written2[p] = c },
    configPath: '/cfg2/providers.json',
    backupPath: '/cfg2/providers.json.bak',
  }
  const result2 = writeProvidersConfigFile([{ id: 'a' }], deps2)
  check(result2.backupPath === null, '原文件不存在 → 无备份')
  const parsed2 = JSON.parse(written2['/cfg2/providers.json'])
  check(parsed2.providers[0].id === 'a', '写入仅含 providers 的最小结构')
}

// ── 测试 9：api.js updateCustomProvider（mock fetch）──
section('测试 9: updateCustomProvider')
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      text: async () => JSON.stringify({ success: true, result: { id: 'cp-1', name: '新名', enable: true } }),
    }
  }

  try {
    const r = await updateCustomProvider('tok', 'acc', 'cp-1', { name: '新名', enable: true })
    check(r.name === '新名' && r.enable === true, '返回更新后的 custom provider')
    check(calls.length === 1, '只发 1 次请求')
    const { url, init } = calls[0]
    check(url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/custom-providers/cp-1', 'PATCH URL 正确')
    check(init.method === 'PATCH', 'method = PATCH')
    check(JSON.parse(init.body).name === '新名' && JSON.parse(init.body).enable === true, 'body 含 name/enable')
    check(init.headers.Authorization === 'Bearer tok', 'Authorization 头正确')

    // 只提交非 undefined 字段
    calls.length = 0
    await updateCustomProvider('tok', 'acc', 'cp-1', { enable: false })
    check(!('name' in JSON.parse(calls[0].init.body)) && JSON.parse(calls[0].init.body).enable === false, '未提供字段不提交')

    // guard：缺 id
    let threw = false
    try { await updateCustomProvider('tok', 'acc', '', { name: 'x' }) } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 id → TypeError')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 测试 10：api.js updateProviderConfig（mock fetch）──
section('测试 10: updateProviderConfig')
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      text: async () => JSON.stringify({ success: true, result: { provider_slug: 'openrouter', alias: '新名' } }),
    }
  }

  try {
    const r = await updateProviderConfig('tok', 'acc', 'gw', '00000000-0000-4000-8000-000000000002', { providerSlug: 'openrouter', secret: 'sk-new', alias: '新名' })
    check(r.provider_slug === 'openrouter', '返回更新后的 provider_config')
    check(calls.length === 1, '只发 1 次请求')
    const { url, init } = calls[0]
    check(url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/gateways/gw/provider_configs/00000000-0000-4000-8000-000000000002', 'PUT URL 用 UUID（非 slug，7001 修正）')
    check(init.method === 'PUT', 'method = PUT')
    const body = JSON.parse(init.body)
    check(body.secret === 'sk-new' && body.alias === '新名' && body.provider_slug === 'openrouter', 'body 含 secret/alias/provider_slug')

    // guard：id / providerSlug / secret 均必填
    let threw = false
    try { await updateProviderConfig('tok', 'acc', 'gw', '', { providerSlug: 'openrouter', secret: 'x' }) } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 id → TypeError')
    threw = false
    try { await updateProviderConfig('tok', 'acc', 'gw', 'uuid', { secret: 'x' }) } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 providerSlug → TypeError')
    threw = false
    try { await updateProviderConfig('tok', 'acc', 'gw', 'uuid', { providerSlug: 'openrouter', alias: 'x' }) } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 secret → TypeError（PUT 端点 secret 必填）')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 测试 11：buildProviderItems（views.js 列表项渲染）──
section('测试 11: buildProviderItems')
{
  const providers = [
    { id: 'openrouter', name: 'OpenRouter', type: 'byok', enabled: false, mark: null },
    { id: 'custom-agnes', name: 'Agnes', type: 'custom-provider', enabled: true, mark: 'new' },
    { id: 'custom-old', name: 'Old', type: 'custom-provider', enabled: true, mark: 'removed' },
  ]
  const items = buildProviderItems(providers)
  check(items.length === 3, '3 个列表项')
  check(items[0].provider.mark === 'new', '[新增] 条目排最前')
  check(items[1].provider.mark === 'removed', '[云端已删] 条目第二')
  check(items[2].provider.id === 'openrouter', '普通条目最后')
  const t0 = items[0].text
  check(t0.includes('custom-agnes') && t0.includes('Agnes') && t0.includes('custom') && t0.includes('启用') && t0.includes('[新增]'), '文本含 slug/name/type/enabled/[新增]')
  check(items[1].text.includes('[云端已删]'), '文本含 [云端已删]')
  check(items[2].text.includes('停用'), 'byok enabled=false 显示停用')
}

// ── 测试 12：场景 F — buildCloudDeleteParams 删除参数组装 ──
section('测试 12: 场景 F — buildCloudDeleteParams')
{
  // custom-provider：带 cloudId（fetchCloudProviders 拉取）→ UUID
  const custom = { id: 'shangtang', cloudId: '00000000-0000-4000-8000-000000000001', name: '商汤', type: 'custom-provider' }
  const r1 = buildCloudDeleteParams(custom)
  check(r1.ok === true && r1.params.kind === 'custom-provider' && r1.params.id === '00000000-0000-4000-8000-000000000001', 'custom → DELETE 用 cloudId（UUID）')
  check(r1.params.slug === undefined, 'custom 不产生 slug 参数')

  // custom-provider：缺 cloudId（本地缓存 / 旧数据）→ 提示刷新
  const r2 = buildCloudDeleteParams({ id: 'shangtang', name: '商汤', type: 'custom-provider' })
  check(r2.ok === false && r2.reason.includes('r'), 'custom 缺 cloudId → 提示先按 r 刷新')

  // byok → DELETE 用 cloudId（provider_config 的 UUID；实测 slug 删除 404/7002）
  const byok = { id: 'openrouter', cloudId: '00000000-0000-4000-8000-000000000002', name: 'OpenRouter', type: 'byok' }
  const r3 = buildCloudDeleteParams(byok)
  check(r3.ok === true && r3.params.kind === 'byok' && r3.params.id === '00000000-0000-4000-8000-000000000002', 'byok → DELETE 用 cloudId（UUID）')

  // byok 缺 cloudId → 提示刷新（与 custom 一致）
  const r3b = buildCloudDeleteParams({ id: 'openrouter', name: 'OpenRouter', type: 'byok' })
  check(r3b.ok === false && r3b.reason.includes('r'), 'byok 缺 cloudId → 提示先按 r 刷新')

  // 异常输入
  const r4 = buildCloudDeleteParams(null)
  check(r4.ok === false && r4.reason, 'null 输入 → 缺 cloudId，不崩溃')
}

// ── 测试 13：deleteProviderCloud 编排（mock 依赖）──
section('测试 13: deleteProviderCloud 编排')
{
  const calls = []
  const deps = {
    deleteCustomFn: async (token, accountId, id) => { calls.push({ kind: 'custom', token, accountId, id }); return null },
    deleteConfigFn: async (token, accountId, gatewayId, id) => { calls.push({ kind: 'byok', token, accountId, gatewayId, id }); return null },
  }

  // custom → deleteCustomFn（cloudId UUID）
  const r1 = await deleteProviderCloud('t1', 'acc', 'gw', { id: 'shangtang', cloudId: '00000000-0000-4000-8000-000000000001', type: 'custom-provider' }, deps)
  check(r1.ok === true && calls.length === 1 && calls[0].kind === 'custom' && calls[0].id === '00000000-0000-4000-8000-000000000001' && calls[0].token === 't1' && calls[0].accountId === 'acc', 'custom 删除参数正确')

  // byok → deleteConfigFn（cloudId UUID + gatewayId）
  calls.length = 0
  const r2 = await deleteProviderCloud('t2', 'acc', 'gw', { id: 'openrouter', cloudId: '00000000-0000-4000-8000-000000000002', type: 'byok' }, deps)
  check(r2.ok === true && calls.length === 1 && calls[0].kind === 'byok' && calls[0].id === '00000000-0000-4000-8000-000000000002' && calls[0].gatewayId === 'gw', 'byok 删除参数正确（UUID + gatewayId）')

  // custom 缺 cloudId → 不触网，返回 reason
  calls.length = 0
  const r3 = await deleteProviderCloud('t3', 'acc', 'gw', { id: 'shangtang', type: 'custom-provider' }, deps)
  check(r3.ok === false && r3.reason && calls.length === 0, '缺 cloudId → 不调用云端函数')

  // 云端抛错 → { ok:false, error }
  calls.length = 0
  const failingDeps = { ...deps, deleteCustomFn: async () => { throw new Error('boom') } }
  const r4 = await deleteProviderCloud('t4', 'acc', 'gw', { id: 'shangtang', cloudId: 'u1', type: 'custom-provider' }, failingDeps)
  check(r4.ok === false && r4.error && r4.error.message === 'boom', '云端抛错 → { ok:false, error }')
}

// ── 测试 14：api.js deleteCustomProvider / deleteProviderConfig（mock fetch）──
section('测试 14: 云端删除 API')
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, text: async () => '{}' }
  }

  try {
    // deleteCustomProvider：DELETE /custom-providers/{UUID}
    await deleteCustomProvider('tok', 'acc', '00000000-0000-4000-8000-000000000001')
    check(calls.length === 1, 'deleteCustomProvider 发 1 次请求')
    const c1 = calls[0]
    check(c1.url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/custom-providers/00000000-0000-4000-8000-000000000001', 'DELETE custom URL 正确')
    check(c1.init.method === 'DELETE', 'method = DELETE')
    check(c1.init.headers.Authorization === 'Bearer tok', 'Authorization 头正确')

    // deleteProviderConfig：DELETE /provider_configs/{UUID}（实测 slug 删除 404/7002）
    calls.length = 0
    await deleteProviderConfig('tok', 'acc', 'gw', '00000000-0000-4000-8000-000000000002')
    check(calls.length === 1, 'deleteProviderConfig 发 1 次请求')
    const c2 = calls[0]
    check(c2.url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/gateways/gw/provider_configs/00000000-0000-4000-8000-000000000002', 'DELETE config URL 正确（UUID）')
    check(c2.init.method === 'DELETE', 'method = DELETE')

    // guard：缺必填参数
    let threw = false
    try { await deleteCustomProvider('tok', 'acc', '') } catch (e) { threw = e instanceof TypeError }
    check(threw, 'deleteCustomProvider 缺 id → TypeError')
    threw = false
    try { await deleteProviderConfig('tok', 'acc', 'gw', '') } catch (e) { threw = e instanceof TypeError }
    check(threw, 'deleteProviderConfig 缺 id → TypeError')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 测试 15：api.js createCustomProvider / updateCustomProvider 线上形态（mock fetch）──
// 实测（2026-08-18）：Cloudflare custom-providers 的 headers 字段必须是 JSON 字符串，
// 对象/空对象 → 400 7001 'Expected string, received object'。函数入参契约保持对象，
// 序列化在线上层完成，此处断言实际发出请求体的形态。
section('测试 15: Custom Provider headers 线上序列化')
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ result: { id: 'u1', slug: 'c1' } }), text: async () => '{}' }
  }

  try {
    // createCustomProvider 带 headers → body.headers 为 JSON 字符串
    await createCustomProvider('tok', 'acc', {
      name: 'Custom1', slug: 'c1', baseUrl: 'https://api.example.com/v1',
      headers: { Authorization: 'Bearer sk-x' }, enable: true,
    })
    check(calls.length === 1, 'createCustomProvider 发 1 次请求')
    const c1 = calls[0]
    const b1 = JSON.parse(c1.init.body)
    check(c1.url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/custom-providers', 'POST URL 正确')
    check(c1.init.method === 'POST', 'method = POST')
    check(typeof b1.headers === 'string' && b1.headers === '{"Authorization":"Bearer sk-x"}', 'headers 序列化为 JSON 字符串')
    check(b1.name === 'Custom1' && b1.slug === 'c1' && b1.base_url === 'https://api.example.com/v1' && b1.enable === true, '其余字段正确透传')

    // createCustomProvider 无 headers → 整字段省略（空对象也会被云端 400）
    calls.length = 0
    await createCustomProvider('tok', 'acc', { name: 'Custom2', slug: 'c2', baseUrl: 'https://api.example.com/v1' })
    check(calls.length === 1, '无 headers 创建也发 1 次请求')
    const b2 = JSON.parse(calls[0].init.body)
    check(!('headers' in b2), '无 headers → body 不含 headers 字段')

    // updateCustomProvider（PATCH）带 headers → 同样序列化为字符串
    calls.length = 0
    await updateCustomProvider('tok', 'acc', 'u1', { headers: { Authorization: 'Bearer sk-y' } })
    const b3 = JSON.parse(calls[0].init.body)
    check(calls[0].init.method === 'PATCH', 'PATCH 方法正确')
    check(typeof b3.headers === 'string' && b3.headers === '{"Authorization":"Bearer sk-y"}', 'PATCH headers 序列化为 JSON 字符串')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── 汇总 ──
console.log(`\n${'='.repeat(56)}`)
console.log(`test-provider-view.mjs: ${checks - failures}/${checks} 通过`)
if (failures > 0) {
  console.log(`${failures} 个断言失败`)
  process.exit(1)
}
