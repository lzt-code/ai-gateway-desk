/**
 * routes-deploy（动态路由部署编排）验证脚本
 *
 * 覆盖：normalizeVersionId 多形态响应 / findRouteBySlug 查找 /
 * deployRouteConfig 编排（新建 → 版本 → 部署；409 查回已有 id；404 重建重试；
 * 各步失败透出错误；入参防御）。API 全部 mock，零触网。
 */

import {
  normalizeVersionId,
  findRouteBySlug,
  deployRouteConfig,
} from '../src/output/routes-deploy.js'

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

// ── 1：normalizeVersionId ────────────────────────────────
section('normalizeVersionId 多形态响应')
check(normalizeVersionId({ result: { version: 3 } }) === 3, 'result.version')
check(normalizeVersionId({ result: { id: 'v9' } }) === 'v9', 'result.id')
check(normalizeVersionId({ data: { version: 2 } }) === 2, 'data.version')
check(normalizeVersionId({ version: 7 }) === 7, '顶层 version')
check(normalizeVersionId({ id: 'abc' }) === 'abc', '顶层 id')
check(normalizeVersionId(null) === null, 'null → null')
check(normalizeVersionId({ result: {} }) === null, '无可识别字段 → null')

// ── 2：findRouteBySlug ──────────────────────────────────
section('findRouteBySlug')
const routes = [
  { id: 'uuid-a', name: 'support' },
  { id: 'uuid-b', name: 'cheap-coder' },
]
check(findRouteBySlug(routes, 'cheap-coder').id === 'uuid-b', '按名命中')
check(findRouteBySlug(routes, 'missing') === null, '未命中 → null')
check(findRouteBySlug(null, 'support') === null, 'null 列表 → null')
check(findRouteBySlug('bad', 'support') === null, '非数组 → null')

// ── 3：deployRouteConfig 编排 ───────────────────────────
section('deployRouteConfig 编排')

const ELEMENTS = [
  { id: 'START', type: 'start', outputs: { next: { elementId: 'END' } } },
  { id: 'END', type: 'end', outputs: {} },
]

// 场景 1：全新部署（无 cloudId）→ 创建 + 版本 + 部署
{
  const calls = []
  const fns = {
    createDynamicRoute: async (t, a, g, body) => {
      calls.push(['create', body.id])
      return { id: 'uuid-new', name: body.id }
    },
    createDynamicRouteVersion: async (t, a, g, routeId, elements) => {
      calls.push(['version', routeId, elements === ELEMENTS])
      return { result: { version: 5 } }
    },
    createDynamicRouteDeployment: async (t, a, g, routeId, { version }) => {
      calls.push(['deploy', routeId, version])
      return { result: { id: 'dep-1' } }
    },
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 'support', elements: ELEMENTS }, fns)
  check(r.ok === true && r.cloudId === 'uuid-new' && r.version === 5 && r.created === true,
    '全新部署：创建→v5→部署 全链成功')
  check(JSON.stringify(calls) === JSON.stringify([['create', 'support'], ['version', 'uuid-new', true], ['deploy', 'uuid-new', 5]]),
    '调用顺序与参数正确')
}

// 场景 2：已有 cloudId → 跳过创建
{
  const calls = []
  const fns = {
    createDynamicRoute: async () => { calls.push(['create']); return { id: 'x' } },
    createDynamicRouteVersion: async () => ({ result: { version: 2 } }),
    createDynamicRouteDeployment: async () => ({}),
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 'support', elements: ELEMENTS, cloudId: 'uuid-exists' }, fns)
  check(r.ok && r.cloudId === 'uuid-exists' && calls.length === 0, '已有 cloudId 不重复创建')
}

// 场景 3：创建 409（云端已存在）→ 从列表查回 id
{
  const fns = {
    createDynamicRoute: async () => {
      const err = new Error('conflict')
      err.status = 409
      throw err
    },
    listDynamicRoutes: async () => [{ id: 'uuid-existing', name: 'support' }],
    createDynamicRouteVersion: async (t, a, g, routeId) => ({ result: { version: 1 } }),
    createDynamicRouteDeployment: async () => ({}),
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 'support', elements: ELEMENTS }, fns)
  check(r.ok && r.cloudId === 'uuid-existing', '创建 409 → 列表查回云端 id 继续部署')
}

// 场景 4：创建 409 且列表查不到 → 失败
{
  const fns = {
    createDynamicRoute: async () => {
      const err = new Error('conflict')
      err.status = 409
      throw err
    },
    listDynamicRoutes: async () => [],
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 'support', elements: ELEMENTS }, fns)
  check(!r.ok && /未能从云端列表取回 id/.test(r.error), '409 且查无此路由 → 明确报错')
}

// 场景 5：版本提交 404（cloudId 失效）→ 重建路由壳重试
{
  const calls = []
  const fns = {
    createDynamicRoute: async (t, a, g, body) => {
      calls.push(['create', body.id])
      return { id: 'uuid-recreated' }
    },
    createDynamicRouteVersion: async (t, a, g, routeId) => {
      calls.push(['version', routeId])
      if (routeId === 'uuid-stale') {
        const err = new Error('not found')
        err.status = 404
        throw err
      }
      return { result: { version: 9 } }
    },
    createDynamicRouteDeployment: async () => ({}),
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 'support', elements: ELEMENTS, cloudId: 'uuid-stale' }, fns)
  check(r.ok && r.cloudId === 'uuid-recreated' && r.version === 9,
    '版本 404 → 重建路由壳后重试成功')
}

// 场景 6：版本提交响应缺版本号 → 失败（无法部署）
{
  const fns = {
    createDynamicRoute: async () => ({ id: 'u1' }),
    createDynamicRouteVersion: async () => ({ result: {} }),
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 's', elements: ELEMENTS }, fns)
  check(!r.ok && /未识别出版本号/.test(r.error), '版本号缺失 → 明确报错不部署')
}

// 场景 7：部署失败 → 错误透出
{
  const fns = {
    createDynamicRoute: async () => ({ id: 'u1' }),
    createDynamicRouteVersion: async () => ({ result: { version: 1 } }),
    createDynamicRouteDeployment: async () => { throw new Error('boom') },
  }
  const r = await deployRouteConfig('tk', 'acc', 'gw', { name: 's', elements: ELEMENTS }, fns)
  check(!r.ok && /部署版本失败：boom/.test(r.error), '部署步骤失败 → 错误透传')
}

// 场景 8：入参防御
{
  const r1 = await deployRouteConfig('tk', 'acc', 'gw', null, {})
  const r2 = await deployRouteConfig('tk', 'acc', 'gw', { name: 's' }, {})
  check(!r1.ok && !r2.ok, '缺 name/elements → 防御性失败不抛错')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
