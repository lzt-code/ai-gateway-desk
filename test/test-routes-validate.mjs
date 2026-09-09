/**
 * 动态路由 elements 校验纯函数验证脚本
 *
 * 覆盖 validateRouteElements 全部规则分支：
 * 空入参 / start 唯一性 / end 必要性 / id 重复 / 未知类型 / 悬挂连线 /
 * 非法输出端口 / model 必填字段 / rate 必填字段 / conditional 条件 /
 * percentage 权重求和 / 合法图通过（直连、fallback 链、真实云端结构）
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

const ok = (elements) => validateRouteElements(elements).ok

// ── 1：入参防御 ──────────────────────────────────────────
section('入参防御')
check(!ok(undefined) && !ok(null) && !ok([]), 'undefined/null/空数组 → 不通过')
check(!ok('not-array'), '字符串 → 不通过')
check(!ok([{}]), '空对象节点 → 不通过（缺 id）')
check(!ok([{ id: 'a' }]), '缺 type → 不通过')

// ── 2：start / end 约束 ─────────────────────────────────
section('start / end 约束')
check(!ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
]), '缺 end → 不通过')
check(!ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'START2', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]), '两个 start → 不通过')
check(ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]), 'START→END 最小图 → 通过')

// ── 3：id 与连线 ─────────────────────────────────────────
section('id 与连线')
check(!ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'START' } } },
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]), 'id 重复 → 不通过')
check(!ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'ghost' } } },
  { id: 'END', type: 'end', outputs: {} },
]), '连线指向不存在节点 → 不通过')
check(!ok([
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: { next: { elementId: 'START' } } },
]), 'end 带输出端口 → 不通过（end 无 outputs）')
check(!ok([
  { id: 'START', type: 'start', outputs: { wrong: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]), 'start 非法输出端口 → 不通过')

// ── 4：model / rate / conditional / percentage 节点 ──────
section('节点 properties')
const graphWith = (node) => ([
  { id: 'START', type: 'start', outputs: { next: { elementId: node.id } } },
  node,
  { id: 'END', type: 'end', outputs: {} },
])
check(!ok(graphWith({ id: 'm', type: 'model', properties: { model: 'gpt' }, outputs: { success: { elementId: 'END' } } })),
  'model 缺 provider → 不通过')
check(!ok(graphWith({ id: 'm', type: 'model', properties: { provider: 'openai' }, outputs: { success: { elementId: 'END' } } })),
  'model 缺 model 名 → 不通过')
check(!ok(graphWith({ id: 'm', type: 'model', properties: { provider: 'p', model: 'm', retries: 'x' }, outputs: { success: { elementId: 'END' } } })),
  'retries 非整数 → 不通过')
check(ok(graphWith({ id: 'm', type: 'model', properties: { provider: 'p', model: 'm' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } })),
  'model 最小合法（含 fallback→END，Cloudflare 7001） → 通过')
check(!ok(graphWith({ id: 'r', type: 'rate', properties: { limitType: 'banana', limit: 0, window: -1 }, outputs: { success: { elementId: 'END' } } })),
  'rate 非法 limitType/limit/window/缺 key → 不通过')
check(ok(graphWith({ id: 'r', type: 'rate', properties: { limitType: 'count', limit: 100, window: 3600, key: 'metadata.user_id' }, outputs: { success: { elementId: 'END' } } })),
  'rate 合法 → 通过')
check(!ok(graphWith({ id: 'c', type: 'conditional', properties: { conditions: {} }, outputs: { true: { elementId: 'END' }, false: { elementId: 'END' } } })),
  'conditional 空条件 → 不通过')
check(ok(graphWith({ id: 'c', type: 'conditional', properties: { conditions: { 'metadata.plan': { '$eq': 'paid' } } }, outputs: { true: { elementId: 'END' }, false: { elementId: 'END' } } })),
  'conditional 合法 → 通过')
check(!ok(graphWith({ id: 'p', type: 'percentage', outputs: { '60%': { elementId: 'END' }, '50%': { elementId: 'END' } } })),
  'percentage 权重和 110 → 不通过')
check(ok(graphWith({ id: 'p', type: 'percentage', outputs: { '70%': { elementId: 'END' }, '30%': { elementId: 'END' } } })),
  'percentage 权重和 100 → 通过')

// ── 5：模板与真实云端结构全部通过 ────────────────────────
section('模板与真实结构')
for (const t of ['direct', 'fallback', 'conditional', 'rate', 'percentage']) {
  const r = validateRouteElements(buildTemplateElements(t))
  check(r.ok, `模板 ${t} 通过校验${r.ok ? '' : '：' + r.errors.join('; ')}`)
}
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
check(ok(REAL_GRAPH), '云端实测流程图（START→fallback 链）通过校验')

// ── 6：pathPrefix provider 防呆警告 ───────────────────────
section('pathPrefix provider 防呆警告')
{
  const warnGraph = graphWith({ id: 'm', type: 'model', properties: { provider: 'custom-fang-zhou', model: 'glm-5.3' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } })
  // 不传 opts：无警告（向后兼容，ok 不受影响）
  const plain = validateRouteElements(warnGraph)
  check(plain.ok && Array.isArray(plain.warnings) && plain.warnings.length === 0,
    '不传 opts → ok=true 且 warnings 为空')
  // 传入数组
  const withArr = validateRouteElements(warnGraph, { customPathProviders: ['custom-fang-zhou', 'custom-other'] })
  check(withArr.ok === true && withArr.warnings.length === 1 && /custom-fang-zhou/.test(withArr.warnings[0]) && /404/.test(withArr.warnings[0]),
    'provider 命中数组 → ok 仍 true + warnings 提示 404')
  // 传入 Set（server 实际用法）
  const withSet = validateRouteElements(warnGraph, { customPathProviders: new Set(['custom-fang-zhou']) })
  check(withSet.ok === true && withSet.warnings.length === 1, 'provider 命中 Set → ok 仍 true + 1 条 warning')
  // 不在集合中的 provider 不警告
  const noHit = validateRouteElements(warnGraph, { customPathProviders: ['custom-shangtang'] })
  check(noHit.ok === true && noHit.warnings.length === 0, 'provider 不在集合 → 无警告')
  // opts 传 null / 畸形值不抛错
  check(validateRouteElements(warnGraph, null).ok === true, 'opts=null → 兼容不抛错')
  // 混合 provider：一个命中一个不命中
  const mixed = [
    { id: 'START', type: 'start', outputs: { next: { elementId: 'm1' } } },
    { id: 'm1', type: 'model', properties: { provider: 'custom-shangtang', model: 'glm-5.2' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'm2' } } },
    { id: 'm2', type: 'model', properties: { provider: 'custom-fang-zhou', model: 'glm-5.3' }, outputs: { success: { elementId: 'END' }, fallback: { elementId: 'END' } } },
    { id: 'END', type: 'end', outputs: {} },
  ]
  const mixedRes = validateRouteElements(mixed, { customPathProviders: new Set(['custom-fang-zhou']) })
  check(mixedRes.ok === true && mixedRes.warnings.length === 1 && /m2/.test(mixedRes.warnings[0]),
    'fallback 链中命中 provider → 按节点 id 精确警告（不误伤其他级）')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
