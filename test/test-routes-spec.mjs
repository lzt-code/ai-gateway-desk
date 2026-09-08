/**
 * 动态路由「表单 spec ↔ elements」互转验证脚本（前端表单编辑器的纯函数层）
 *
 * 覆盖：
 *  - parseModelRef：provider/模型名 切分约定（第一个 '/'）与非法入参
 *  - elementsFromRouteSpec：五种模板 spec 生成合法图（经 validateRouteElements 交叉验证）、
 *    非法引用 / 权重和 / 限额字段 → null
 *  - routeSpecFromElements：模板图 ↔ spec 双向 round-trip（spec 级相等）、
 *    真实云端结构可表单化、超表单能力的结构 → null（降级 JSON 模式）
 */

import { validateRouteElements } from '../src/pipeline/routes-validate.js'
import { buildTemplateElements } from '../src/web/public/app.js'

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

// app.js 顶层除被测函数外还有 DOM 启动逻辑，Node 环境按既有测试方式直接 import
const app = await import('../src/web/public/app.js')
const { parseModelRef, elementsFromRouteSpec, routeSpecFromElements } = app

const KINDS = ['direct', 'fallback', 'conditional', 'rate', 'percentage']

// ── 1：parseModelRef ─────────────────────────────────────
section('parseModelRef 切分约定')
check(JSON.stringify(parseModelRef('openai/gpt-4o-mini')) === JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini' }),
  '常规 provider/模型')
check(JSON.stringify(parseModelRef('custom-opencode/deepseek-v4-flash')) === JSON.stringify({ provider: 'custom-opencode', model: 'deepseek-v4-flash' }),
  'custom- 前缀 slug')
check(JSON.stringify(parseModelRef('workersai/@cf/meta/llama')) === JSON.stringify({ provider: 'workersai', model: '@cf/meta/llama' }),
  '模型名含 / → 按第一个 / 切分（与 worker 约定一致）')
check(parseModelRef('no-slash') === null, '无 / → null')
check(parseModelRef('/gpt') === null, '空 provider → null')
check(parseModelRef('openai/') === null, '空模型名 → null')
check(parseModelRef('') === null && parseModelRef(null) === null && parseModelRef(42) === null,
  '空串/null/数字 → null')

// ── 2：elementsFromRouteSpec ────────────────────────────
section('elementsFromRouteSpec 生成合法图')
for (const kind of KINDS) {
  const elements = elementsFromRouteSpec(app.__specFixtureForKind
    ? app.__specFixtureForKind(kind)
    : routeSpecFromElements(buildTemplateElements(kind)))
  check(Array.isArray(elements), `spec(${kind}) → elements`)
  if (Array.isArray(elements)) {
    const r = validateRouteElements(elements)
    check(r.ok, `spec(${kind}) 生成的图通过结构校验${r.ok ? '' : '：' + r.errors.join('; ')}`)
  }
}
check(elementsFromRouteSpec({ kind: 'direct', primary: { model: 'no-slash' } }) === null,
  '模型引用缺 provider → null')
check(elementsFromRouteSpec({ kind: 'percentage', branches: [{ pct: 60, model: 'a/b' }, { pct: 30, model: 'c/d' }] }) === null,
  '灰度权重和 90 → null')
check(elementsFromRouteSpec({ kind: 'rate', limit: 0, window: -1, key: 'k', primary: { model: 'a/b' }, backup: { model: 'c/d' } }) === null,
  '限额字段非法 → null')
check(elementsFromRouteSpec({ kind: 'conditional', condition: { field: '', op: '$eq', value: 'x' }, trueModel: { model: 'a/b' }, falseModel: { model: 'c/d' } }) === null,
  '条件字段为空 → null')
check(elementsFromRouteSpec(null) === null && elementsFromRouteSpec({ kind: 'alien' }) === null,
  'null / 未知 kind → null')

// ── 3：routeSpecFromElements round-trip ─────────────────
section('spec ↔ elements 双向 round-trip（spec 级相等）')
for (const kind of KINDS) {
  const template = buildTemplateElements(kind)
  const spec1 = routeSpecFromElements(template)
  const regenerated = spec1 && elementsFromRouteSpec(spec1)
  const spec2 = regenerated && routeSpecFromElements(regenerated)
  check(
    spec1 && spec2 && JSON.stringify(spec1) === JSON.stringify(spec2),
    `模板 ${kind}：图 → spec → 图 → spec 保持一致`,
  )
}

// 真实云端结构（实测：主模型 fallback → 二级模型，二级 fallback 回 END）
const REAL_GRAPH = [
  { id: 'START', outputs: { next: { elementId: 'primary-model' } }, type: 'start' },
  {
    id: 'primary-model',
    outputs: { success: { elementId: 'END' }, fallback: { elementId: 'model-1787133423687-yzggmy' } },
    type: 'model',
    properties: { provider: 'custom-opencode', model: 'deepseek-v4-flash-free', timeout: 3000, retries: 3 },
  },
  { id: 'END', outputs: {}, type: 'end' },
  {
    id: 'model-1787133423687-yzggmy',
    outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } },
    type: 'model',
    properties: { provider: 'custom-shangtang', model: 'deepseek-v4-flash', timeout: 0, retries: 0 },
  },
]
{
  const spec = routeSpecFromElements(REAL_GRAPH)
  check(spec && spec.kind === 'fallback' &&
    spec.models.length === 2 &&
    spec.models[0].model === 'custom-opencode/deepseek-v4-flash-free' &&
    spec.models[1].model === 'custom-shangtang/deepseek-v4-flash',
  '云端实测 fallback 图 → 可表单化（主/备模型正确）')
}

section('N 级 fallback 链（Cloudflare 原生无限级）')
// 三级链：可表单化 + round-trip
{
  const three = [
    { id: 'START', type: 'start', outputs: { next: { elementId: 'm1' } } },
    { id: 'm1', type: 'model', properties: { provider: 'a', model: '1' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'm2' } } },
    { id: 'm2', type: 'model', properties: { provider: 'c', model: '2' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'm3' } } },
    { id: 'm3', type: 'model', properties: { provider: 'e', model: '3' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } },
    { id: 'END', type: 'end', outputs: {} },
  ]
  const spec = routeSpecFromElements(three)
  check(spec && spec.kind === 'fallback' && spec.models.length === 3, '三级链 → fallback spec（models 长度 3）')
  const regen = spec && elementsFromRouteSpec(spec)
  const r = regen && validateRouteElements(regen)
  check(r && r.ok, '三级链再生成通过结构校验')
  const s2 = regen && routeSpecFromElements(regen)
  check(s2 && JSON.stringify(spec) === JSON.stringify(s2), '三级链 spec round-trip 一致')
}
// 四级链：由 spec 生成 + fallback 边逐级连接断言
{
  const spec4 = {
    kind: 'fallback',
    models: [{ model: 'a/1' }, { model: 'b/2' }, { model: 'c/3' }, { model: 'd/4' }],
  }
  const els4 = elementsFromRouteSpec(spec4)
  const ok4 = els4 && validateRouteElements(els4)
  check(ok4 && ok4.ok, '四级链 spec 生成合法图（通过结构校验）')
  const byId = new Map((els4 || []).map((n) => [n.id, n]))
  check(
    byId.get('model-level-1')?.outputs?.fallback?.elementId === 'model-level-2' &&
    byId.get('model-level-2')?.outputs?.fallback?.elementId === 'model-level-3' &&
    byId.get('model-level-3')?.outputs?.fallback?.elementId === 'model-level-4' &&
    byId.get('model-level-4')?.outputs?.fallback?.elementId === 'END',
    '四级链 fallback 边逐级连接、末级 fallback→END（Cloudflare 7001 必填）',
  )
}
// 链外孤儿模型：无法用线性链表达 → null（编辑器降级 JSON）
check(routeSpecFromElements([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'm1' } } },
  { id: 'm1', type: 'model', properties: { provider: 'a', model: '1' }, outputs: { success: { elementId: 'END' } } },
  { id: 'orphan', type: 'model', properties: { provider: 'x', model: 'y' }, outputs: { success: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]) === null, '链外孤儿模型 → null')
// fallback 成环 → null
check(routeSpecFromElements([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'm1' } } },
  { id: 'm1', type: 'model', properties: { provider: 'a', model: '1' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'm2' } } },
  { id: 'm2', type: 'model', properties: { provider: 'c', model: '2' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'm1' } } },
  { id: 'END', type: 'end', outputs: {} },
]) === null, 'fallback 成环 → null')

section('超表单能力的结构 → null（编辑器降级 JSON 模式）')
check(routeSpecFromElements(null) === null && routeSpecFromElements([]) === null, '空入参 → null')
check(routeSpecFromElements([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]) === null, '无模型节点 → null')
check(routeSpecFromElements([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'c' } } },
  { id: 'c', type: 'conditional', properties: { conditions: { 'metadata.a': { '$eq': '1' }, 'metadata.b': { '$eq': '2' } } }, outputs: { true: { elementId: 'END' }, false: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]) === null, '条件节点含两组条件 → null')
check(routeSpecFromElements([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
  { id: 'x', type: 'alien', outputs: {} },
]) === null, '未知节点类型 → null')

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
