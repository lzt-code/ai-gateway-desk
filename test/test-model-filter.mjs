/**
 * 模型筛选纯函数测试（任务 19）
 *
 * 纯逻辑测试：不触网、不启动真实 TUI、不渲染 blessed 屏幕。
 * 覆盖 actions.js 的 filterModelsByProvider / filterModelsByKeyword /
 * applyModelFilters / collectProviders。
 *
 * 场景：
 *   A: filterModelsByProvider(state, 'openrouter') → 只含 openrouter 的模型（2 项）
 *   B: filterModelsByKeyword(state, 'deep') → id/name 模糊匹配（deepseek-r1）
 *   C: 组合筛选（provider + keyword）→ 交集
 *   D: 无匹配 → 返回空数组（列表显示「无匹配模型」）
 *   E: 大小写不敏感（'DEEP' 也能匹配）
 *   F: 筛选不修改原 state（深拷贝断言）
 */

import {
  filterModelsByProvider,
  filterModelsByKeyword,
  applyModelFilters,
  collectProviders,
} from '../src/tui/actions.js'
import { buildFilterBar, buildListItems } from '../src/tui/render.js'

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

// ── 测试数据（任务 19 数据样例：metadata.provider 形式）──
const sampleState = {
  'openrouter/deepseek-r1': { status: 'selected', metadata: { provider: 'openrouter', name: 'DeepSeek R1' } },
  'openrouter/gpt-4o':      { status: 'hidden',   metadata: { provider: 'openrouter', name: 'GPT-4o' } },
  'custom-agnes/agnes':     { status: 'selected', metadata: { provider: 'custom-agnes', name: 'Agnes' } },
}

const modelIds = (items) => items.map((i) => i.modelId).sort()

// ── 测试 1：模块导出 ──
section('测试 1: 导出')
check(typeof filterModelsByProvider === 'function', 'filterModelsByProvider 已导出')
check(typeof filterModelsByKeyword === 'function', 'filterModelsByKeyword 已导出')
check(typeof applyModelFilters === 'function', 'applyModelFilters 已导出')
check(typeof collectProviders === 'function', 'collectProviders 已导出')

// ── 测试 2：场景 A — 按 provider 筛选 ──
section('测试 2: 场景 A — filterModelsByProvider')
{
  const result = filterModelsByProvider(sampleState, 'openrouter')
  check(result.length === 2, `provider=openrouter → 2 项（实际 ${result.length}）`)
  check(modelIds(result).join(',') === 'openrouter/deepseek-r1,openrouter/gpt-4o',
    '仅含 openrouter 的模型')
  const agnes = filterModelsByProvider(sampleState, 'custom-agnes')
  check(agnes.length === 1 && agnes[0].modelId === 'custom-agnes/agnes', 'custom-agnes → 1 项（agnes）')
  check(filterModelsByProvider(sampleState, '不存在').length === 0, '未知 provider → 空数组')
  check(filterModelsByProvider(sampleState, null).length === 0, '空 provider → 空数组')
}

// ── 测试 3：场景 B — 按关键字筛选 ──
section('测试 3: 场景 B — filterModelsByKeyword')
{
  const result = filterModelsByKeyword(sampleState, 'deep')
  check(result.length === 1, `关键字 deep → 1 项（实际 ${result.length}）`)
  check(result[0].modelId === 'openrouter/deepseek-r1', '命中 id（deepseek-r1）')
  const byName = filterModelsByKeyword(sampleState, 'gpt')
  check(byName.length === 1 && byName[0].modelId === 'openrouter/gpt-4o', '命中 name（GPT-4o）')
}

// ── 测试 4：场景 C — 组合筛选（交集）──
section('测试 4: 场景 C — applyModelFilters 组合')
{
  const result = applyModelFilters(sampleState, { provider: 'openrouter', keyword: 'deep' })
  check(result.length === 1 && result[0].modelId === 'openrouter/deepseek-r1',
    'provider=openrouter + 关键字=deep → 交集 1 项')
  // 组合不匹配（provider 对但关键字错）
  const none = applyModelFilters(sampleState, { provider: 'openrouter', keyword: 'agnes' })
  check(none.length === 0, 'provider 对但关键字不匹配 → 空数组')
  // 单条件：只有 provider
  const onlyP = applyModelFilters(sampleState, { provider: 'openrouter', keyword: null })
  check(onlyP.length === 2, '仅 provider 条件 → 2 项')
  // 单条件：只有关键字
  const onlyK = applyModelFilters(sampleState, { provider: null, keyword: 'agnes' })
  check(onlyK.length === 1 && onlyK[0].modelId === 'custom-agnes/agnes', '仅关键字条件 → 1 项')
  // 无筛选条件 → 全部
  const all = applyModelFilters(sampleState, {})
  check(all.length === 3, '无筛选条件 → 全部 3 项')
  // 仅按 status 筛选
  const selected = applyModelFilters(sampleState, { status: 'selected' })
  check(selected.length === 2, '仅 status=selected → 2 项')
  const hidden = applyModelFilters(sampleState, { status: 'hidden' })
  check(hidden.length === 1 && hidden[0].modelId === 'openrouter/gpt-4o', '仅 status=hidden → 1 项 gpt-4o')
  const removed = applyModelFilters(sampleState, { status: 'removed' })
  check(removed.length === 0, 'status=removed → 0 项（样本中无 removed）')
  // 组合：provider + status
  const pS = applyModelFilters(sampleState, { provider: 'openrouter', status: 'selected' })
  check(pS.length === 1 && pS[0].modelId === 'openrouter/deepseek-r1', 'provider+status 交集 → 1 项')
}

// ── 测试 5：场景 D — 无匹配返回空数组 ──
section('测试 5: 场景 D — 无匹配 → 空数组')
{
  check(Array.isArray(filterModelsByProvider(sampleState, 'nope')), 'provider 无匹配返回数组')
  check(Array.isArray(filterModelsByKeyword(sampleState, 'zzzz')), '关键字无匹配返回数组')
  check(filterModelsByKeyword(sampleState, 'zzzz').length === 0, '关键字无匹配 → 空数组')
}

// ── 测试 6：场景 E — 大小写不敏感 ──
section('测试 6: 场景 E — 大小写不敏感')
{
  const upper = filterModelsByKeyword(sampleState, 'DEEP')
  check(upper.length === 1 && upper[0].modelId === 'openrouter/deepseek-r1', "'DEEP' 匹配 deepseek-r1")
  const mixed = filterModelsByKeyword(sampleState, 'GpT-4')
  check(mixed.length === 1 && mixed[0].modelId === 'openrouter/gpt-4o', "'GpT-4' 匹配 gpt-4o")
}

// ── 测试 7：场景 F — 不修改原 state ──
section('测试 7: 场景 F — 筛选不修改原 state')
{
  const before = JSON.stringify(sampleState)
  filterModelsByProvider(sampleState, 'openrouter')
  filterModelsByKeyword(sampleState, 'deep')
  applyModelFilters(sampleState, { provider: 'openrouter', keyword: 'deep' })
  collectProviders(sampleState)
  check(JSON.stringify(sampleState) === before, '筛选后原 state 深拷贝不变')
}

// ── 测试 8：collectProviders 去重排序 + 顶层 provider 兼容 ──
section('测试 8: collectProviders + 顶层 provider 兼容')
{
  const providers = collectProviders(sampleState)
  check(providers.join(',') === 'custom-agnes,openrouter', '去重排序: custom-agnes,openrouter')

  // 真实 state（upsertModel 写入）条目带顶层 provider 字段，无 metadata.provider
  const realState = {
    'openrouter/a': { status: 'selected', provider: 'openrouter', metadata: { name: 'A' } },
    'openrouter/b': { status: 'hidden', provider: 'openrouter', metadata: { name: 'B' } },
  }
  const viaTop = filterModelsByProvider(realState, 'openrouter')
  check(viaTop.length === 2, '顶层 provider 字段同样可筛选')
  check(collectProviders(realState).join(',') === 'openrouter', '顶层 provider 参与去重收集')
}

// ── 测试 9：buildFilterBar（列表顶部筛选状态栏）──
section('测试 9: buildFilterBar 渲染')
{
  check(buildFilterBar({ provider: null, keyword: null }) === null, '无筛选 → null（隐藏筛选栏）')
  check(buildFilterBar({}) === null, '空对象 → null')
  const onlyP = buildFilterBar({ provider: 'openrouter', keyword: null })
  check(typeof onlyP === 'string' && onlyP.includes('provider=openrouter'), '仅 provider → 含 provider=openrouter')
  const both = buildFilterBar({ provider: 'openrouter', keyword: 'deep' })
  check(both.includes('provider=openrouter') && both.includes('关键字=deep'),
    '组合 → 同时含 provider 与关键字')
  check(both.includes('ESC'), '含 ESC 清除提示')
}

// ── 测试 10：集成 — 筛选结果可被 buildListItems 直接渲染 ──
section('测试 10: 筛选 → 列表渲染集成')
{
  // TUI refreshList 流程：applyModelFilters → Object.fromEntries → buildListItems
  const toState = (items) => Object.fromEntries(items.map(({ modelId, entry }) => [modelId, entry]))
  const filtered = toState(applyModelFilters(sampleState, { provider: 'openrouter' }))
  const items = buildListItems(filtered)
  check(items.length === 2, 'provider=openrouter 筛选后列表渲染 2 项')
  check(items.every((i) => i.modelId.startsWith('openrouter/')), '渲染项均为 openrouter 模型')

  const keywordItems = buildListItems(toState(applyModelFilters(sampleState, { keyword: 'DEEP' })))
  check(keywordItems.length === 1 && keywordItems[0].modelId === 'openrouter/deepseek-r1',
    "关键字 'DEEP' 筛选后列表渲染 1 项（deepseek-r1）")

  const none = buildListItems(toState(applyModelFilters(sampleState, { keyword: 'zzz' })))
  check(none.length === 0, '无匹配 → 渲染空列表（TUI 显示「无匹配模型」提示）')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
