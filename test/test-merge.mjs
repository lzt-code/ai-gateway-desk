/**
 * mergeDiscovery 纯函数测试（策略 A：provider 覆盖 + 未发现→物理删除）
 *
 * 纯逻辑测试：不触网、不读写文件。
 * 覆盖：新增 / metadata 更新 / hidden 跨同步保持 / 消失模型物理删除 /
 *       manual 豁免 / 未查询的 provider 豁免 / 无变更空汇总。
 */

import { mergeDiscovery } from '../src/pipeline/merge.js'

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

const results = (providers) => ({ results: providers.map(([provider, models]) => ({ provider, models })), errors: [] })

// ── 测试 1：新增模型 → selected ──
section('新增模型')
{
  const r = mergeDiscovery({}, results([['openrouter', [{ id: 'openrouter/m1', name: 'M1' }]]]))
  check(r.state['openrouter/m1']?.status === 'selected', '新模型默认 selected')
  check(JSON.stringify(r.newModels) === JSON.stringify(['openrouter/m1']), '计入 newModels')
  check(r.removedModels.length === 0 && r.updatedModels.length === 0, '无移除/更新')
}

// ── 测试 2：已存在模型 metadata 覆盖 ──
section('metadata 更新')
{
  const state = { 'openrouter/m1': { status: 'hidden', provider: 'openrouter', metadata: { name: 'old' } } }
  const r = mergeDiscovery(state, results([['openrouter', [{ id: 'openrouter/m1', name: 'new' }]]]))
  check(r.state['openrouter/m1'].metadata.name === 'new', 'provider 返回字段覆盖 metadata')
  check(r.state['openrouter/m1'].status === 'hidden', 'hidden 状态跨同步保持不变')
  check(JSON.stringify(r.updatedModels) === JSON.stringify(['openrouter/m1']), 'metadata 变化计入 updatedModels')
}

// ── 测试 3：消失模型 → 物理删除 ──
section('未发现 → 物理删除')
{
  const state = {
    'openrouter/gone': { status: 'selected', provider: 'openrouter', metadata: {} },
    'openrouter/gone-hidden': { status: 'hidden', provider: 'openrouter', metadata: {} },
  }
  const r = mergeDiscovery(state, results([['openrouter', []]]))
  check(!('openrouter/gone' in r.state), 'selected 消失 → 条目直接删除（无 removed 中间态）')
  check(!('openrouter/gone-hidden' in r.state), 'hidden 消失 → 条目直接删除')
  check(JSON.stringify(r.removedModels.sort()) === JSON.stringify(['openrouter/gone', 'openrouter/gone-hidden']),
    '删除计入 removedModels')
  // 原 state 不被修改
  check('openrouter/gone' in state && 'openrouter/gone-hidden' in state, '入参 state 不被修改（深拷贝）')
}

// ── 测试 4：manual 模型豁免 ──
section('manual 豁免')
{
  const state = { 'p/manual': { status: 'selected', provider: 'p', manual: true, metadata: {} } }
  const r = mergeDiscovery(state, results([['p', []]]))
  check('p/manual' in r.state, 'manual 模型上游不再返回 → 保留')
  check(r.removedModels.length === 0, '不计入 removedModels')
}

// ── 测试 5：未查询的 provider 豁免 ──
section('未查询 provider 豁免')
{
  const state = { 'other/m1': { status: 'selected', provider: 'other', metadata: {} } }
  // 本次只查询了 openrouter（other 拉取失败/被隐藏 → 不在 results 中）
  const r = mergeDiscovery(state, results([['openrouter', []]]))
  check('other/m1' in r.state, 'provider 未被查询 → 模型保留（不误删）')
}

// ── 测试 6：无变更 → 空汇总 ──
section('无变更')
{
  const state = { 'openrouter/m1': { status: 'selected', provider: 'openrouter', metadata: { name: 'M1' } } }
  const r = mergeDiscovery(state, results([['openrouter', [{ id: 'openrouter/m1', name: 'M1' }]]]))
  check(r.newModels.length === 0 && r.updatedModels.length === 0 && r.removedModels.length === 0, '全量命中 → 空汇总')
}

// ── 测试 7：存量 removed 条目迁移 ──
section('存量 removed 迁移')
{
  const state = {
    'openrouter/legacy': { status: 'removed', provider: 'openrouter', metadata: {} },
    'openrouter/legacy-gone': { status: 'removed', provider: 'openrouter', metadata: {} },
  }
  const r = mergeDiscovery(state, results([['openrouter', [{ id: 'openrouter/legacy', name: 'M' }]]]))
  check(r.state['openrouter/legacy'].status === 'selected', '上游仍返回的存量 removed → 归位 selected')
  check(JSON.stringify(r.updatedModels) === JSON.stringify(['openrouter/legacy']), '迁移计入 updatedModels（保证落盘）')
  check(!('openrouter/legacy-gone' in r.state), '上游已不返回的存量 removed → 直接删除')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
