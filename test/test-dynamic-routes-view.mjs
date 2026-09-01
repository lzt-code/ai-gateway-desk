/**
 * 动态路由视图验证脚本：fallback 链归一化 + 路由收集纯函数 + 视图骨架契约
 *
 * 覆盖：
 *  - discover.js normalizeRouteModelChain：字符串直连 / 数组 fallback / 空值与非法输入
 *  - discover.js parseRouteFallbackChain：version.data 流程图（实测结构）→ fallback 链
 *  - app.js collectDynamicRoutes：dynamic/ 条目收集、route_models 归一化、
 *    旧数据（无 route_models）降级、非 dynamic 条目忽略、脏输入安全
 *  - index.html 结构断言：「动态路由」tab 紧随「模型」之后、view-routes 容器存在
 *
 * 浏览器内渲染（路由卡片 / 外链精化 / 刷新）由浏览器手工验收。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const discover = await import('../src/cloudflare/discover.js')
const app = await import('../src/web/public/app.js')
const { normalizeRouteModelChain, parseRouteFallbackChain } = discover
const { collectDynamicRoutes, VIEWS, VIEW_ORDER } = app

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

// ── 1：normalizeRouteModelChain ──────────────────────────
section('normalizeRouteModelChain 归一化')
check(
  JSON.stringify(normalizeRouteModelChain('@cf/meta/llama-2-7b')) ===
    JSON.stringify(['@cf/meta/llama-2-7b']),
  '字符串直连 → 单元素数组',
)
check(
  JSON.stringify(normalizeRouteModelChain(['gpt-4o-mini', '@cf/meta/llama'])) ===
    JSON.stringify(['gpt-4o-mini', '@cf/meta/llama']),
  '字符串数组 fallback → 原样保留（顺序即尝试顺序）',
)
check(
  JSON.stringify(normalizeRouteModelChain(['gpt-4o', '  ', '', 42])) === JSON.stringify(['gpt-4o']),
  '数组内空串/空白/非字符串项被过滤',
)
check(normalizeRouteModelChain('   ') === undefined, '纯空白字符串 → undefined')
check(normalizeRouteModelChain([]) === undefined, '空数组 → undefined')
check(normalizeRouteModelChain(['', '  ']) === undefined, '过滤后为空的数组 → undefined')
check(normalizeRouteModelChain(undefined) === undefined, 'undefined → undefined')
check(normalizeRouteModelChain(null) === undefined, 'null → undefined')
check(normalizeRouteModelChain(42) === undefined, '数字 → undefined')
check(normalizeRouteModelChain({ a: 1 }) === undefined, '对象 → undefined')

// ── 1b：parseRouteFallbackChain（version.data 流程图，2026-09-01 实测结构）─
section('parseRouteFallbackChain 流程图解析')
// 真实结构（deepseek_v4_flash_route 实测）：START → primary-model → fallback → 二级模型 → END
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
check(
  JSON.stringify(parseRouteFallbackChain(REAL_GRAPH)) ===
    JSON.stringify(['custom-opencode/deepseek-v4-flash-free', 'custom-shangtang/deepseek-v4-flash']),
  '实测流程图：START→primary→fallback 按序解析为 provider/model 链',
)
check(
  JSON.stringify(parseRouteFallbackChain([
    { id: 'START', outputs: { next: { elementId: 'only' } }, type: 'start' },
    { id: 'only', outputs: { success: { elementId: 'END' } }, type: 'model', properties: { provider: 'p', model: 'm' } },
    { id: 'END', outputs: {}, type: 'end' },
  ])) === JSON.stringify(['p/m']),
  '无 fallback（success 直达 END）→ 单元素直连链',
)
check(
  parseRouteFallbackChain([
    { id: 'START', outputs: { next: { elementId: 'a' } }, type: 'start' },
    { id: 'a', outputs: { success: { elementId: 'END' }, fallback: { elementId: 'a' } }, type: 'model', properties: { provider: 'p', model: 'm' } },
  ]) !== undefined,
  'fallback 自环（防环守卫）不挂死，返回已有链',
)
check(
  parseRouteFallbackChain([
    { id: 'START', outputs: { next: { elementId: 'END' } }, type: 'start' },
    { id: 'END', outputs: {}, type: 'end' },
  ]) === undefined,
  'START 直达 END（无模型节点）→ undefined',
)
check(
  parseRouteFallbackChain([
    { id: 'START', outputs: { next: { elementId: 'x' } }, type: 'start' },
    { id: 'x', type: 'model', properties: { provider: '', model: 'm' }, outputs: { fallback: { elementId: 'END' } } },
  ]) === undefined,
  '模型节点缺 provider → 空链归一化为 undefined',
)
check(parseRouteFallbackChain(null) === undefined, 'null → undefined')
check(parseRouteFallbackChain('not-array') === undefined, '非数组 → undefined')
check(parseRouteFallbackChain([]) === undefined, '空数组 → undefined')

// ── 2：collectDynamicRoutes ──────────────────────────────
section('collectDynamicRoutes 收集与归一化')
const state = {
  'custom-opencode/big-pickle': {
    status: 'selected',
    provider: 'custom-opencode',
    metadata: { id: 'custom-opencode/big-pickle', name: 'Big Pickle' },
  },
  'dynamic/support': {
    status: 'selected',
    provider: 'dynamic',
    metadata: {
      id: 'dynamic/support',
      name: 'support',
      created: 1787104498,
      route_models: ['gpt-4o-mini', '@cf/meta/llama'],
    },
  },
  'dynamic/cheap-coder': {
    status: 'selected',
    provider: 'dynamic',
    metadata: { id: 'dynamic/cheap-coder', name: 'cheap-coder', route_models: 'direct-model' },
  },
  // 旧数据：route_models 字段出现前同步（无该字段）
  'dynamic/legacy-route': {
    status: 'selected',
    provider: 'dynamic',
    metadata: { id: 'dynamic/legacy-route', name: 'legacy-route', created: 1700000000 },
  },
  'dynamic/gone-route': {
    status: 'removed',
    provider: 'dynamic',
    metadata: { id: 'dynamic/gone-route', name: 'gone-route', route_models: ['m1', 'm2', 'm3'] },
  },
}
const routes = collectDynamicRoutes(state)
check(routes.length === 4, '仅收集 dynamic/ 前缀条目（4 条，忽略普通模型）')
check(routes[0].modelId === 'dynamic/support', '保持 state 插入顺序')
check(JSON.stringify(routes[0].chain) === JSON.stringify(['gpt-4o-mini', '@cf/meta/llama']), '数组链原样保留')
check(routes[0].name === 'support' && routes[0].status === 'selected' && routes[0].created === 1787104498,
  'name/created/status 从 metadata 透出')
check(JSON.stringify(routes[1].chain) === JSON.stringify(['direct-model']), '字符串直连归一化为单元素数组')
check(JSON.stringify(routes[2].chain) === JSON.stringify([]), '旧数据无 route_models → 空数组降级')
check(routes[3].status === 'removed' && routes[3].chain.length === 3, 'removed 条目照常收集（链透出，展示层自行处理）')
check(
  collectDynamicRoutes(null).length === 0 && collectDynamicRoutes(undefined).length === 0,
  'null/undefined state 安全返回空数组',
)
check(collectDynamicRoutes({}).length === 0, '空 state 返回空数组')
check(
  collectDynamicRoutes({ 'dynamic/x': null, 'dynamic/y': {} }).length === 2,
  '脏条目（entry 为 null/无 metadata）不抛错并兜底',
)

// ── 3：视图契约（VIEWS / VIEW_ORDER）────────────────────
section('视图契约')
check(VIEWS.ROUTES === 'routes', "VIEWS.ROUTES === 'routes'")
check(
  VIEW_ORDER.indexOf('routes') === VIEW_ORDER.indexOf('models') + 1,
  'routes 紧随 models 之后（模型列表后面）',
)

// ── 4：index.html 结构断言 ───────────────────────────────
section('index.html 结构断言')
const html = await readFile(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8')
const modelsTab = html.indexOf('data-view="models"')
const routesTab = html.indexOf('data-view="routes"')
const workersTab = html.indexOf('data-view="workers"')
check(modelsTab !== -1 && routesTab !== -1 && workersTab !== -1, '三个 tab 按钮均存在')
check(routesTab > modelsTab && routesTab < workersTab, '「动态路由」tab 位于「模型」之后、「Worker」之前')
check(/<section\s+class="view"\s+id="view-routes"\s+hidden>/.test(html), '视图容器 view-routes 存在（hidden）')
const modelsViewPos = html.indexOf('id="view-models"')
const routesViewPos = html.indexOf('id="view-routes"')
const workersViewPos = html.indexOf('id="view-workers"')
check(routesViewPos > modelsViewPos && routesViewPos < workersViewPos, 'view-routes 容器位置与 tab 顺序一致')

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
