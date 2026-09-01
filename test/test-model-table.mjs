/**
 * 模型表格 + Provider 侧栏纯函数测试（任务 24）
 *
 * 纯逻辑测试：不触网、不启动真实 TUI、不渲染 blessed 屏幕。
 * 覆盖 views.js 的 buildListItems（表格式行）/ buildTableHeader /
 * buildProviderSidebarItems 与 actions.js 的 toggleAllStatus（按筛选范围切换）。
 *
 * 场景：
 *   A: buildListItems 生成表格式行（模型ID/Provider/上下文/状态 四列对齐）
 *   B: 长模型 id 截断（显示宽度安全）
 *   C: buildTableHeader 与行共用列宽（对齐）
 *   D: buildProviderSidebarItems（第一项「全部」+ 计数 + 排序 + 截断）
 *   E: toggleAllStatus 仅切换指定模型（筛选结果）
 *   F: 集成——侧栏筛选结果喂给 F2（applyModelFilters → toggleAllStatus）
 */

import { buildListItems, buildTableHeader, buildProviderSidebarItems, strWidth } from '../src/tui/render.js'
import { toggleAllStatus, applyModelFilters, deleteModel } from '../src/tui/actions.js'

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

// 显示宽度（剥离 blessed 标签后按 CJK 双宽统计）
const widthOf = (s) => strWidth(String(s).replace(/\{[^}]*\}/g, ''))

// ── 测试数据 ──
const sampleState = {
  'openrouter/deepseek-r1': { status: 'selected', metadata: { provider: 'openrouter', name: 'DeepSeek R1', context_length: 128000 } },
  'openrouter/gpt-4o':      { status: 'hidden',   metadata: { provider: 'openrouter', name: 'GPT-4o' } },
  'custom-agnes/agnes':     { status: 'selected', metadata: { provider: 'custom-agnes', name: 'Agnes', context_length: 32000 } },
}

// ── 测试 1：模块导出 ──
section('测试 1: 导出')
check(typeof buildListItems === 'function', 'buildListItems 已导出')
check(typeof buildTableHeader === 'function', 'buildTableHeader 已导出')
check(typeof buildProviderSidebarItems === 'function', 'buildProviderSidebarItems 已导出')
check(typeof toggleAllStatus === 'function', 'toggleAllStatus 已导出')

// ── 测试 2：场景 A — buildListItems 表格式行 ──
section('测试 2: 场景 A — 表格行格式')
{
  const items = buildListItems(sampleState, 60)
  check(items.length === 3, `3 个模型 → 3 行（实际 ${items.length}）`)

  // 排序：selected 组在 hidden 前；行宽 = 表格宽度
  check(items[0].modelId.startsWith('openrouter/deepseek') || items[0].modelId.startsWith('custom-agnes/agnes'),
    'selected 组排前（deepseek-r1 / agnes）')
  check(items.every((i) => widthOf(i.text) === 60), '每行显示宽度 = 表格宽度 60')

  const row = items.find((i) => i.modelId === 'openrouter/deepseek-r1')
  check(row && row.text.includes('openrouter/deepseek-r1'), '行含完整模型 id')
  check(row && row.text.includes('128K'), '行含格式化上下文 128K（右对齐）')
  check(row && row.text.includes('选中'), 'selected 行含「选中」状态文字')
  check(row && row.text.includes('{green-fg}◉{/green-fg}'), 'selected 行含绿色 ◉ 图标')
  check(row && row.text.includes('openrouter'), '行含 provider 列')

  // max_output_length 测试
  const withOut = buildListItems({ 'p/m': { status: 'selected', metadata: { context_length: 128000, max_output_length: 4096 } } }, 60)
  check(withOut[0] && withOut[0].text.includes('128K'), 'max_output_length 行含上下文 128K')
  check(withOut[0] && withOut[0].text.includes('4K'), 'max_output_length 行含输出 4K')

  const hidden = items.find((i) => i.modelId === 'openrouter/gpt-4o')
  check(hidden && hidden.text.includes('隐藏'), 'hidden 行含「隐藏」状态文字')
  check(hidden && hidden.text.includes('{yellow-fg}○{/yellow-fg}'), 'hidden 行含黄色 ○ 图标')
}

// ── 测试 3：场景 B — 长 id 截断（显示宽度安全）──
section('测试 3: 场景 B — 长模型 id 截断')
{
  const longId = 'very-long-provider/very-long-model-name-that-overflows-the-column'
  const items = buildListItems({ [longId]: { status: 'selected', metadata: { provider: 'p' } } }, 60)
  const row = items[0]
  check(widthOf(row.text) < strWidth(longId), '超长 id 被截断（行显示宽度小于原始 id 宽度）')
  check(row.text.includes('…'), '截断处有省略号')
  check(widthOf(row.text) === 60, '截断后行宽仍 = 60（不溢出）')
  // 列内不换行：行内容单行显示（无换行符）
  check(!row.text.includes('\n'), '行内无换行符')
}

// ── 测试 4：场景 C — buildTableHeader 对齐 ──
section('测试 4: 场景 C — 表头')
{
  const header = buildTableHeader(60)
  check(typeof header === 'string' && header.includes('模型ID'), '表头含「模型ID」')
  check(header.includes('Provider') && header.includes('上下文') && header.includes('状态'),
    '表头含 Provider / 上下文 / 状态 列名')
  check(widthOf(header) === 60, '表头显示宽度 = 60（与行对齐）')
  // 表头与行在 40 宽（窄屏）下也一致
  const narrow = buildTableHeader(40)
  const narrowRow = buildListItems({ 'a/b': { status: 'selected', metadata: {} } }, 40)[0]
  check(widthOf(narrow) === 40 && widthOf(narrowRow.text) === 40, '窄屏 40 宽下表头与行对齐')
}

// ── 测试 5：场景 D — buildProviderSidebarItems ──
section('测试 5: 场景 D — Provider 侧栏条目')
{
  const items = buildProviderSidebarItems(sampleState, 16)
  check(items.length === 3, `侧栏 3 项（全部 + 2 个 provider），实际 ${items.length}`)
  check(items[0].provider === null, '第一项是「全部」（provider=null）')
  check(items[0].text.includes('全部'), '第一项显示「全部」')
  check(items[0].count === 3, `「全部」计数 = 全部模型 3（实际 ${items[0].count}）`)
  check(items[1].provider === 'custom-agnes' && items[2].provider === 'openrouter',
    'provider 按 id 排序：custom-agnes, openrouter')
  check(items[1].count === 1 && items[2].count === 2, '各 provider 计数正确（1 / 2）')
  check(items.every((i) => widthOf(i.text) === 16), '每条宽度 = 16（侧栏宽度）')

  // 超长 provider 截断
  const longP = 'very-long-provider-name'
  const items3 = buildProviderSidebarItems({ [`${longP}/m`]: { status: 'selected', metadata: { provider: longP } } }, 16)
  check(items3.length === 2 && items3[1].text.includes('…'), '超长 provider 名截断并含省略号')
  check(widthOf(items3[1].text) === 16, '截断后宽度仍 = 16')
}

// ── 测试 6：场景 E — toggleAllStatus 按筛选范围 + deleteModel ──
section('测试 6: 场景 E — toggleAllStatus 按范围切换 / deleteModel')
{
  const st = {
    a: { status: 'selected' },
    b: { status: 'hidden' },
    d: { status: 'selected' },
  }
  const changed = toggleAllStatus(st, ['a', 'b'])
  check(changed === true, '范围内有可切换模型 → 返回 true')
  check(st.a.status === 'hidden' && st.b.status === 'hidden', '范围内有选中 → 全部隐藏（a/b 均 hidden）')
  check(st.d.status === 'selected', '范围外模型不受影响（d 保持 selected）')

  // 范围内全隐藏 → 切为全部选中
  const st2 = { a: { status: 'hidden' }, b: { status: 'hidden' } }
  toggleAllStatus(st2, ['a', 'b'])
  check(st2.a.status === 'selected' && st2.b.status === 'selected', '范围内无选中 → 全部选中')

  // 缺省参数 = 全部模型（向后兼容）
  const st3 = { a: { status: 'hidden' }, b: { status: 'selected' } }
  toggleAllStatus(st3)
  check(st3.a.status === 'hidden' && st3.b.status === 'hidden',
    '缺省 modelIds 时作用于全部模型（有选中 → 全隐藏）')

  // 空范围 → 无变更
  const st4 = { a: { status: 'selected' } }
  check(toggleAllStatus(st4, []) === false, '空范围 → 返回 false')
  check(toggleAllStatus(st4, ['a', 'ghost']) === true && st4.a.status === 'hidden',
    '范围含不存在 id 时跳过（不抛错）')
  const st5 = { a: { status: 'selected' } }
  check(toggleAllStatus(st5, ['a']) === true, '单模型范围正常切换')
  const st6 = { a: { status: 'selected' } }
  check(toggleAllStatus(st6, ['ghost']) === false, '范围全是缺失 id → 返回 false')

  // deleteModel：物理删除 + 幂等
  const st7 = { a: { status: 'selected' }, b: { status: 'hidden' } }
  check(deleteModel(st7, 'a') === true && !('a' in st7), 'deleteModel 直接删除条目')
  check(deleteModel(st7, 'ghost') === false, '删除不存在的 id → false')
}

// ── 测试 7：场景 F — 集成（侧栏筛选结果喂给 F2）──
section('测试 7: 场景 F — 筛选 → F2 集成')
{
  const st = JSON.parse(JSON.stringify(sampleState))
  // index.js F2：applyModelFilters(state, filter) → toggleAllStatus(state, ids)
  const ids = applyModelFilters(st, { provider: 'openrouter', keyword: null }).map(({ modelId }) => modelId)
  check(ids.length === 2, `openrouter 筛选 → 2 个目标（实际 ${ids.length}）`)
  toggleAllStatus(st, ids)
  check(st['openrouter/deepseek-r1'].status === 'hidden' && st['openrouter/gpt-4o'].status === 'hidden',
    'F2 隐藏了筛选结果中的 openrouter 模型')
  check(st['custom-agnes/agnes'].status === 'selected', '筛选范围外模型不受 F2 影响')

  // 无筛选时 F2 = 全量（缺省参数路径）
  const st2 = JSON.parse(JSON.stringify(sampleState))
  const allIds = applyModelFilters(st2, {}).map(({ modelId }) => modelId)
  toggleAllStatus(st2, allIds)
  check(Object.values(st2).every((e) => e.status === 'hidden'), '无筛选 → F2 作用于全部模型')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
