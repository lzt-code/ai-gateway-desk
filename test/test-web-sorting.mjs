/**
 * Web 表格排序纯函数测试（Provider / 模型列表列排序）
 *
 * 纯逻辑测试：无 DOM、不触网。覆盖 app.js 的：
 *  - sortViewItems：升/降序、不修改原数组、稳定性、字符串数字感知比较
 *  - nextSortState：三态循环（未排序 → asc → desc → 未排序）+ 换列重置 asc
 *  - MODEL_SORT_GETTERS：name（缺失回退 id 尾段）/ modelId / context（先上下文后输出，缺失排前）/ status
 *  - PROVIDER_SORT_GETTERS：slug / name / type / visibility（启用在前，列名「状态」）
 */

const mod = await import('../src/web/public/app.js')
const {
  sortViewItems,
  nextSortState,
  PROVIDER_SORT_GETTERS,
  MODEL_SORT_GETTERS,
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

// ── fixtures ──────────────────────────────────────────────
const modelItems = [
  { modelId: 'openrouter/gpt-4o', entry: { status: 'hidden', metadata: { name: 'GPT-4o', context_length: 128000, max_output_length: 16384 } } },
  { modelId: 'custom-agnes/agnes', entry: { status: 'selected', metadata: { name: 'Agnes', context_length: '32000' } } },
  { modelId: 'openrouter/deepseek-r1', entry: { status: 'hidden', metadata: {} } },
]

const providers = [
  { id: 'zeta', name: 'Zeta', type: 'custom-provider', enabled: false },
  { id: 'agnes', name: 'Agnes', type: 'custom-provider', enabled: true, mark: 'new' },
  { id: 'openrouter', name: null, type: 'byok', enabled: true, mark: 'removed' },
  { id: 'beta', name: 'beta', type: 'byok', enabled: true },
]

// ── 测试 1：导出 ──
section('测试 1: 导出')
check(typeof sortViewItems === 'function', 'sortViewItems 已导出')
check(typeof nextSortState === 'function', 'nextSortState 已导出')
check(!!PROVIDER_SORT_GETTERS && typeof PROVIDER_SORT_GETTERS === 'object', 'PROVIDER_SORT_GETTERS 已导出')
check(!!MODEL_SORT_GETTERS && typeof MODEL_SORT_GETTERS === 'object', 'MODEL_SORT_GETTERS 已导出')

// ── 测试 2：sortViewItems 基础行为 ──
section('测试 2: sortViewItems 基础行为')
{
  const src = [3, 1, 2]
  const asc = sortViewItems(src, (n) => n)
  check(JSON.stringify(asc) === '[1,2,3]', `数值升序 [1,2,3]（实际 ${JSON.stringify(asc)}）`)
  check(JSON.stringify(src) === '[3,1,2]', '原数组不被修改')
  const desc = sortViewItems(src, (n) => n, 'desc')
  check(JSON.stringify(desc) === '[3,2,1]', `数值降序 [3,2,1]（实际 ${JSON.stringify(desc)}）`)

  // 字符串：数字感知 + 忽略大小写（gpt-4o 在 gpt-4o-mini 前；大小写混排不按码点）
  const strs = ['b2', 'B10', 'a']
  check(JSON.stringify(sortViewItems(strs, (s) => s)) === JSON.stringify(['a', 'b2', 'B10']),
    '字符串排序数字感知且忽略大小写（b2 < B10）')

  // 稳定性：相等元素保持原相对顺序
  const stable = [
    { k: 1, tag: 'first' },
    { k: 1, tag: 'second' },
    { k: 0, tag: 'zero' },
  ]
  const sorted = sortViewItems(stable, (x) => x.k)
  check(sorted[0].tag === 'zero' && sorted[1].tag === 'first' && sorted[2].tag === 'second',
    '相等键保持原相对顺序（稳定排序）')

  // 空数组 / null 容错
  check(sortViewItems(null, (x) => x).length === 0, 'null 输入 → 空数组')
}

// ── 测试 3：nextSortState 三态循环 ──
section('测试 3: nextSortState 三态循环')
{
  let s = nextSortState(null, 'asc', 'name')
  check(s.key === 'name' && s.dir === 'asc', '未排序点击 → 该列升序')
  s = nextSortState(s.key, s.dir, 'name')
  check(s.key === 'name' && s.dir === 'desc', '同列再点 → 降序')
  s = nextSortState(s.key, s.dir, 'name')
  check(s.key === null, '同列三击 → 清除排序（回到默认顺序）')
  s = nextSortState(null, 'asc', 'modelId')
  check(s.key === 'modelId' && s.dir === 'asc', '清除后再点其他列 → 升序')
  const sw = nextSortState('context', 'desc', 'status')
  check(sw.key === 'status' && sw.dir === 'asc', '降序状态换列 → 新列升序')
}

// ── 测试 4：MODEL_SORT_GETTERS ──
section('测试 4: MODEL_SORT_GETTERS')
{
  // name：metadata.name 优先，缺失回退 modelId 尾段（deepseek-r1 无 name）
  const byNameAsc = sortViewItems(modelItems, MODEL_SORT_GETTERS.name)
  check(byNameAsc.map((i) => i.modelId)[0] === 'custom-agnes/agnes', '按名称升序：Agnes 最前')
  check(byNameAsc.map((i) => i.modelId).includes('openrouter/deepseek-r1'),
    '缺 name 回退 id 尾段参与排序（deepseek-r1 在列）')
  const byNameDesc = sortViewItems(modelItems, MODEL_SORT_GETTERS.name, 'desc')
  check(byNameDesc.map((i) => i.modelId)[0] !== byNameAsc.map((i) => i.modelId)[0], '名称降序与升序相反')

  // modelId：custom- < openrouter/
  const byId = sortViewItems(modelItems, MODEL_SORT_GETTERS.modelId)
  check(byId[0].modelId === 'custom-agnes/agnes' && byId[2].modelId === 'openrouter/gpt-4o',
    '按模型ID升序：custom-agnes 前、openrouter/gpt-4o 后')

  // context：数值比较 + 字符串值归一 + 缺失(-1)排最前；上下文相同再比输出
  const byCtx = sortViewItems(modelItems, MODEL_SORT_GETTERS.context)
  check(byCtx[0].modelId === 'openrouter/deepseek-r1', 'context 缺失(-1)排最前')
  check(byCtx[1].modelId === 'custom-agnes/agnes' && byCtx[2].modelId === 'openrouter/gpt-4o',
    'context 字符串 "32000" 按 32000 排序（< 128000）')
  const ctxTie = [
    { modelId: 'p/a', entry: { status: 'selected', metadata: { context_length: 1000, max_output_length: 4096 } } },
    { modelId: 'p/b', entry: { status: 'selected', metadata: { context_length: 1000, max_output_length: 1024 } } },
  ]
  check(sortViewItems(ctxTie, MODEL_SORT_GETTERS.context)[0].modelId === 'p/b',
    '上下文相同时按输出长度升序')

  // status：selected(0) < hidden(1)
  const byStatus = sortViewItems(modelItems, MODEL_SORT_GETTERS.status)
  check(byStatus.map((i) => i.entry.status).join(',') === 'selected,hidden,hidden',
    '状态排序：selected → hidden')
}

// ── 测试 5：PROVIDER_SORT_GETTERS ──
section('测试 5: PROVIDER_SORT_GETTERS')
{
  const bySlug = sortViewItems(providers, PROVIDER_SORT_GETTERS.slug)
  check(bySlug.map((p) => p.id).join(',') === 'agnes,beta,openrouter,zeta', '按 slug 升序字母序')

  const byName = sortViewItems(providers, PROVIDER_SORT_GETTERS.name)
  check(byName[0].id === 'openrouter' || byName[0].id === 'agnes', 'name=null 归空串参与排序（不抛错）')

  const byType = sortViewItems(providers, PROVIDER_SORT_GETTERS.type)
  check(byType[0].type === 'byok' && byType[3].type === 'custom-provider', 'type 升序：byok 在 custom-provider 前')

  const byVis = sortViewItems(providers, PROVIDER_SORT_GETTERS.visibility)
  check(byVis.slice(0, 3).every((p) => p.enabled !== false), '状态（visibility）升序：启用在前')
  check(byVis[3].enabled === false, '隐藏(zeta)排最后')

  // 集成：模型表按状态升序喂给行构建器顺序保持一致
  const rows = mod.buildModelTableRows(sortViewItems(modelItems, MODEL_SORT_GETTERS.status))
  check(rows.length === 3 && rows[0].modelId === 'custom-agnes/agnes', '排序结果直接喂 buildModelTableRows 顺序一致')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
