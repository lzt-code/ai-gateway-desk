/**
 * 任务 31 验证脚本：前端模型视图纯函数
 *
 * 覆盖（交付包 §5.1 的 19 个用例）：
 *  - buildModelTableRows：三状态图标 / Provider 兼容 / 上下文千分位 / 缺失 / 空数组
 *  - parseSSEEvents：完整流 / 坏 data / 空文本
 *  - buildSyncProgressState：discover / done / error / 空
 *  - filterQuery：全空 / 单条件 / 双条件 + 编码
 *  - computeDirty：无变化 / 有变化 / 键序无关深比较
 *  - 导出存在性：5 个新函数 + 任务 30 导出回归
 *
 * 无 DOM 环境，视图交互（侧栏/表格/同步/保存）由浏览器手工验收（交付包 §6）。
 */

import { fileURLToPath } from 'node:url'

const mod = await import('../src/web/public/app.js')
const {
  buildModelTableRows,
  parseSSEEvents,
  buildSyncProgressState,
  buildDebugLogLines,
  filterQuery,
  computeDirty,
  copyToClipboard,
  api,
  showDialog,
  flash,
  registerViewRenderer,
  createState,
} = mod

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

// ── 1-5：buildModelTableRows ─────────────────────────────
section('buildModelTableRows')
{
  const items = [
    { modelId: 'openrouter/deepseek-r1', entry: { status: 'selected', metadata: { provider: 'openrouter' } } },
    { modelId: 'openrouter/gpt-4o', entry: { status: 'hidden', metadata: { provider: 'openrouter' } } },
  ]
  const rows = buildModelTableRows(items)
  check(rows.length === 2, '两种状态 → 行数 2')
  check(rows.every((r) => r.html.includes('data-model-id=')), '每行含 data-model-id')
  check(
    rows[0].html.includes('◉') && rows[1].html.includes('○'),
    '图标分别 ◉ / ○',
  )
  check(
    rows[0].html.includes('status-ok') && rows[1].html.includes('status-warn'),
    'class 分别 status-ok / status-warn',
  )
  check(
    rows[0].html.includes('class="model-copy"') && rows[0].html.includes('data-copy-model="openrouter/deepseek-r1"'),
    '模型名后包含复制按钮（data-copy-model = 完整 modelId 含 provider）',
  )
}
{
  const rows = buildModelTableRows([
    { modelId: 'a/m1', entry: { status: 'selected', metadata: { name: 'DeepSeek R1' } } },
    { modelId: 'openrouter/x-ai/grok-4.20', entry: { status: 'selected', metadata: {} } },
  ])
  check(
    rows[0].html.includes('class="model-name-text"') && rows[0].html.includes('DeepSeek R1'),
    '展示模型名称（metadata.name → 模型名称列）',
  )
  check(
    rows[1].html.includes('>grok-4.20</span>'),
    '无 name → 名称回退为 modelId 最后一段（grok-4.20）',
  )
}
{
  // 操作列：手工模型有 编辑+删除，非手工只有 编辑
  const rows = buildModelTableRows([
    { modelId: 'p/manual-m', entry: { status: 'selected', manual: true, metadata: {} } },
    { modelId: 'p/sync-m', entry: { status: 'selected', metadata: {} } },
  ])
  check(rows[0].html.includes('model-edit') && rows[0].html.includes('data-edit-model="p/manual-m"'),
    '手工模型 → 行内编辑按钮（data-edit-model）')
  check(rows[0].html.includes('model-delete') && rows[0].html.includes('data-delete-model="p/manual-m"'),
    '手工模型 → 行内删除按钮（data-delete-model）')
  check(rows[1].html.includes('model-edit') && rows[1].html.includes('data-edit-model="p/sync-m"'),
    '非手工模型 → 行内编辑按钮')
  check(!rows[1].html.includes('model-delete') && !rows[1].html.includes('data-delete-model'),
    '非手工模型 → 无删除按钮（同步自动删除，无需手动）')
}
{
  // Provider 不再单独成列：id 前缀已含归属（custom-agnes/...），侧栏负责筛选
  const rows = buildModelTableRows([
    { modelId: 'custom-agnes/m1', entry: { status: 'selected', metadata: { provider: 'custom-agnes' } } },
    { modelId: 'b/2', entry: { status: 'selected', provider: 'top-prov', metadata: {} } },
  ])
  check(rows[0].html.includes('custom-agnes/m1'), 'provider 归属由模型ID 前缀体现')
  check(
    !rows[0].html.includes('<td>custom-agnes</td>') && !rows[1].html.includes('<td>top-prov</td>'),
    'Provider 列已移除（不渲染独立单元格）',
  )
}
{
  const rows = buildModelTableRows([{ modelId: 'x/1', entry: { status: 'selected', metadata: { context_length: 65536 } } }])
  check(rows[0].html.includes('64K/-'), '仅 context_length → "64K/-"（输出侧 - 占位）')
}
{
  const rows = buildModelTableRows([{ modelId: 'x/1', entry: { status: 'selected', metadata: { max_output_length: 4096 } } }])
  check(rows[0].html.includes('-/4K'), '仅 max_output_length → "-/4K"（上下文侧 - 占位）')
}
{
  const cases = [
    [{ context_length: 1048576, max_output_length: 262144 }, '1M/256K'],
    [{ context_length: 131072, max_output_length: 8192 }, '128K/8K'],
    [{ context_length: 1536, max_output_length: 512 }, '1.5K/512'],
    [{ context_length: '65536', max_output_length: null }, '64K/-'],
    [{ context_length: 0, max_output_length: 0 }, '0/0'],
    [{}, ''],
  ]
  for (const [meta, expected] of cases) {
    const rows = buildModelTableRows([{ modelId: 'x/1', entry: { status: 'selected', metadata: meta } }])
    check(rows[0].html.includes(`<td>${expected}</td>`), `${JSON.stringify(meta)} → "${expected}"`)
  }
}
{
  // 进制自适应：整千按 1000 进，否则按 1024 进
  const cases = [
    [{ context_length: 128000, max_output_length: 32000 }, '128K/32K'],
    [{ context_length: 1000000, max_output_length: 65536 }, '1M/64K'],
    [{ context_length: 200000, max_output_length: null }, '200K/-'],
  ]
  for (const [meta, expected] of cases) {
    const rows = buildModelTableRows([{ modelId: 'x/1', entry: { status: 'selected', metadata: meta } }])
    check(rows[0].html.includes(`<td>${expected}</td>`), `${JSON.stringify(meta)} → "${expected}"（1000 进制）`)
  }
}
check(
  Array.isArray(buildModelTableRows([])) && buildModelTableRows([]).length === 0,
  '空数组 → 返回空数组（视图显示空状态文案）',
)
{
  // 本次同步新增模型高亮：newModelIds 命中的行加 row-new 类 + 名称前置「新增」徽章
  const items = [
    { modelId: 'p/new-m', entry: { status: 'selected', metadata: {} } },
    { modelId: 'p/old-m', entry: { status: 'selected', metadata: {} } },
    { modelId: 'dynamic/route', entry: { status: 'selected', metadata: {} } },
  ]
  // Set 形态
  const rowsSet = buildModelTableRows(items, new Set(['p/new-m', 'dynamic/route']))
  check(rowsSet[0].html.includes('class="row-selected row-new"'), '命中 newModelIds → row-new 类')
  check(rowsSet[0].html.includes('class="new-tag"') && rowsSet[0].html.includes('>新增</span>'), '新增行 → 名称前置「新增」徽章')
  check(!rowsSet[1].html.includes('row-new') && !rowsSet[1].html.includes('new-tag'), '未命中 → 无 row-new / 徽章')
  // 动态路由 + 新增：两个徽章并存，类同时含 row-dynamic row-new
  check(
    rowsSet[2].html.includes('class="row-selected row-dynamic row-new"'),
    '动态路由且新增 → row-dynamic + row-new 共存',
  )
  check(
    rowsSet[2].html.includes('dynamic-tag') && rowsSet[2].html.includes('new-tag'),
    '动态路由 + 新增 → 「动态路由」与「新增」徽章并存',
  )
  // Array 形态也归一化
  const rowsArr = buildModelTableRows(items, ['p/new-m'])
  check(rowsArr[0].html.includes('row-new'), 'Array 形态 newModelIds 同样生效（归一为 Set）')
  // 缺省 / 空集合 → 不触发高亮
  const rowsNone = buildModelTableRows(items)
  check(!rowsNone.some((r) => r.html.includes('row-new')), '缺省 newModelIds → 无任何 row-new')
  const rowsEmpty = buildModelTableRows(items, new Set())
  check(!rowsEmpty.some((r) => r.html.includes('row-new')), '空 Set → 无任何 row-new')
}

// ── 6-8：parseSSEEvents ──────────────────────────────────
section('parseSSEEvents')
{
  const text = [
    'event: phase',
    'data: {"phase":"discover"}',
    '',
    'event: discover',
    'data: {"provider":"custom-agnes","status":"done","models":2,"done":1,"total":3}',
    '',
    'event: discover',
    'data: {"provider":"openrouter","status":"done","models":1,"done":2,"total":3}',
    '',
    'event: enrich',
    'data: {"enriched":1,"total":2}',
    '',
    'event: done',
    'data: {"summary":{"newModels":["custom-agnes/agnes"],"updatedModels":[],"removedModels":[],"errors":[]}}',
    '',
  ].join('\n')
  const events = parseSSEEvents(text)
  check(events.length === 5, '完整流 → 事件数 5（phase→discover×2→enrich→done）')
  check(events[0].event === 'phase' && events[0].data.phase === 'discover', 'phase 事件 event/data 正确')
  check(
    events[1].event === 'discover' && events[1].data.provider === 'custom-agnes' && events[1].data.models === 2,
    'discover 事件正确（data 已 JSON.parse 为对象）',
  )
  check(events[3].event === 'enrich' && events[3].data.enriched === 1, 'enrich 事件正确')
  check(events[4].event === 'done' && events[4].data.summary.newModels.length === 1, 'done 事件正确')
}
{
  const events = parseSSEEvents('event: x\ndata: {bad json}\n\n')
  check(
    events.length === 1 && events[0].event === 'x' && events[0].data === null,
    '坏 data → 该事件 data===null 不抛错',
  )
}
check(Array.isArray(parseSSEEvents('')) && parseSSEEvents('').length === 0, '空文本 → 返回 []')

// ── 9-12：buildSyncProgressState ──────────────────────────
section('buildSyncProgressState')
{
  const st = buildSyncProgressState([
    { event: 'discover', data: { provider: 'p-pending', status: 'pending' } },
    { event: 'discover', data: { provider: 'p-done', status: 'done', models: 3 } },
    { event: 'discover', data: { provider: 'p-err', status: 'error', error: '400 Bad Request: Invalid provider' } },
  ])
  check(Object.keys(st.providers).length === 3, 'discover 事件 → providers 映射 3 个')
  check(st.providers['p-pending'].status === 'pending', 'pending → status "pending"')
  check(st.providers['p-done'].status === 'done' && st.providers['p-done'].models === 3, 'done → status done + models')
  check(
    st.providers['p-err'].status === 'error' && st.providers['p-err'].error.includes('Invalid provider'),
    'error → status error + error 文本',
  )
}
{
  const st = buildSyncProgressState([
    { event: 'done', data: { summary: { newModels: ['x'], updatedModels: [], removedModels: [], errors: [] } } },
  ])
  check(st.phase === 'done', 'done 事件 → phase "done"')
  check(st.summary && st.summary.newModels.length === 1, 'done 事件 → summary 被解析')
}
{
  const st = buildSyncProgressState([{ event: 'error', data: { message: '同步失败原因' } }])
  check(st.error === '同步失败原因', 'error 事件 → error 字段带 message')
}
{
  const st = buildSyncProgressState([])
  check(
    st.providers && Object.keys(st.providers).length === 0 && st.phase === null,
    '空事件 → providers 空对象 + phase null',
  )
}
{
  // debug 事件不影响进度：done 之后的 debug 事件不得把状态改回 pending
  const st = buildSyncProgressState([
    { event: 'discover', data: { provider: 'p1', status: 'pending' } },
    { event: 'discover', data: { provider: 'p1', status: 'debug', debug: { phase: 'request', method: 'GET', url: 'u', headers: {} } } },
    { event: 'discover', data: { provider: 'p1', status: 'done', models: 2 } },
    { event: 'discover', data: { provider: 'p1', status: 'debug', debug: { phase: 'response', httpStatus: 200, headers: {}, bytes: 10, elapsedMs: 5, bodyPreview: 'x', truncated: false } } },
  ])
  check(st.providers['p1'].status === 'done' && st.providers['p1'].models === 2, 'debug 事件被忽略（done 状态保持）')
  check(Object.keys(st.providers).length === 1, '仅 debug 事件的 provider 不入映射不受影响')
}

// ── buildDebugLogLines（debug 事件 → 日志行）──────────────
section('buildDebugLogLines')
{
  check(buildDebugLogLines('p1', null).length === 0, '载荷缺失 → 空数组')
  check(buildDebugLogLines('p1', { phase: 'unknown' }).length === 0, '未知 phase → 空数组')
  const reqLines = buildDebugLogLines('p1', {
    phase: 'request', method: 'GET', url: 'https://gw/v1/p1/v1/models',
    headers: { 'cf-aig-authorization': 'Bearer cfut_abcd****ef12', accept: 'application/json' },
  })
  check(reqLines.length === 2, 'request → 2 行（请求行 + 请求头）')
  check(reqLines[0].text.includes('GET https://gw/v1/p1/v1/models'), '请求行含 method + url')
  check(reqLines[1].text.includes('cf-aig-authorization'), '请求头行含脱敏头')
  const respLines = buildDebugLogLines('p1', {
    phase: 'response', httpStatus: 200, statusText: 'OK', headers: { 'content-type': 'application/json' },
    bytes: 5000, elapsedMs: 123, bodyPreview: '{"data": [...', truncated: true,
  })
  check(respLines.length === 3, 'response → 3 行（状态行 + 响应头 + 预览）')
  check(respLines[0].type === 'ok' && respLines[0].text.includes('HTTP 200 OK'), '2xx 状态行为 ok 类型')
  check(respLines[2].text.includes('完整响应体见服务器终端'), 'truncated → 提示看服务器终端')
  const errLines = buildDebugLogLines('bad', {
    phase: 'response', httpStatus: 400, statusText: 'Bad Request', headers: {},
    bytes: 60, elapsedMs: 9, bodyPreview: '{"error":"x"}', truncated: false,
  })
  check(errLines[0].type === 'warn', '非 2xx 状态行为 warn 类型')
  check(!errLines.some((l) => l.text.includes('服务器终端')), '未截断 → 不提示终端')
}

// ── 13-15：filterQuery ───────────────────────────────────
section('filterQuery')
check(filterQuery({}) === '', '全空 → 返回 ""')
check(filterQuery() === '', '无参数 → 返回 ""')
check(filterQuery({ provider: 'custom-agnes' }) === 'provider=custom-agnes', '单条件 → provider=custom-agnes')
{
  const q = filterQuery({ provider: 'a b', keyword: '深/度', status: 'selected' })
  check(q.includes('provider=a%20b'), 'provider 含空格 → encodeURIComponent 编码')
  check(q.includes('keyword=' + encodeURIComponent('深/度')), 'keyword 含中文与 / → encodeURIComponent 编码')
  check(q.includes('status=selected'), 'status 参数正确编码')
  check(q.split('&').length === 3, '三条件以 & 连接')
}
{
  const q = filterQuery({ status: 'hidden' })
  check(q === 'status=hidden', '仅 status → 单条件')
}

// ── 16-17：computeDirty（KV 投影比较）─────────────────────
section('computeDirty')
{
  const snapshot = { 'a/1': { status: 'selected', metadata: { name: 'A' } } }
  check(computeDirty(snapshot, { 'a/1': { status: 'selected', metadata: { name: 'A' } } }) === false, '无变化 → false')
  check(computeDirty(snapshot, { 'a/1': { status: 'hidden', metadata: { name: 'A' } } }) === true, 'selected → hidden（KV 产物变化）→ true')
  // 非 selected 条目的增删不影响 KV 产物 → false
  check(computeDirty(snapshot, {
    'a/1': { status: 'selected', metadata: { name: 'A' } },
    'b/2': { status: 'hidden', metadata: { name: 'B' } },
  }) === false, '新增 hidden 条目 → false（不入 models.json）')
  check(computeDirty(snapshot, {}) === true, 'selected 条目被删除 → true')
  // selected 条目 metadata 变化 → true
  check(computeDirty(snapshot, { 'a/1': { status: 'selected', metadata: { name: 'A2' } } }) === true, 'selected metadata 变化 → true')
  const reordered = { 'a/1': { metadata: { name: 'A' }, status: 'selected' } }
  check(computeDirty(snapshot, reordered) === false, '键序不同内容相同 → false（键序无关深比较）')
}

// ── 18-19：导出存在性 + 任务 30 回归 ─────────────────────
section('导出存在性')
for (const fn of [buildModelTableRows, parseSSEEvents, buildSyncProgressState, buildDebugLogLines, filterQuery, computeDirty, copyToClipboard]) {
  check(typeof fn === 'function', `新纯函数 ${fn.name} 已导出`)
}
check((await copyToClipboard('x')) === false, 'copyToClipboard 无 DOM 安全返回 false')

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
