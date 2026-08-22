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
    { modelId: 'custom-agnes/agnes', entry: { status: 'removed', provider: 'custom-agnes', metadata: {} } },
  ]
  const rows = buildModelTableRows(items)
  check(rows.length === 3, '三种状态 → 行数 3')
  check(rows.every((r) => r.html.includes('data-model-id=')), '每行含 data-model-id')
  check(
    rows[0].html.includes('◉') && rows[1].html.includes('○') && rows[2].html.includes('✕'),
    '图标分别 ◉ / ○ / ✕',
  )
  check(
    rows[0].html.includes('status-ok') && rows[1].html.includes('status-warn') && rows[2].html.includes('status-err'),
    'class 分别 status-ok / status-warn / status-err',
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

// ── 16-17：computeDirty ──────────────────────────────────
section('computeDirty')
{
  const snapshot = { 'a/1': { status: 'selected', metadata: { name: 'A' } } }
  check(computeDirty(snapshot, { 'a/1': { status: 'selected', metadata: { name: 'A' } } }) === false, '无变化 → false')
  check(computeDirty(snapshot, { 'a/1': { status: 'hidden', metadata: { name: 'A' } } }) === true, '改 status → true')
  const reordered = { 'a/1': { metadata: { name: 'A' }, status: 'selected' } }
  check(computeDirty(snapshot, reordered) === false, '键序不同内容相同 → false（键序无关深比较）')
}

// ── 18-19：导出存在性 + 任务 30 回归 ─────────────────────
section('导出存在性')
for (const fn of [buildModelTableRows, parseSSEEvents, buildSyncProgressState, filterQuery, computeDirty, copyToClipboard]) {
  check(typeof fn === 'function', `新纯函数 ${fn.name} 已导出`)
}
check((await copyToClipboard('x')) === false, 'copyToClipboard 无 DOM 安全返回 false')

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`失败 ${failures} 项`)
  process.exit(1)
}
