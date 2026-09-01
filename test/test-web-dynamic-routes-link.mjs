/**
 * 动态路由外部入口验证脚本：模型页侧栏「动态路由 ↗」链接构建纯函数
 *
 * 覆盖：
 *  - buildCfDynamicRoutesUrl：accountId/gatewayId 齐全 → 直达网关动态路由页（/routing）
 *  - 「未配置」占位 / 缺失 / 空串 / 空白 / 非字符串 → 回退 AI Gateway 列表页
 *  - URL 特殊字符转义（encodeURIComponent）
 *  - CF_GATEWAY_FALLBACK_URL 常量导出
 *  - applyCfRoutesLink：Node 无 DOM 环境安全 no-op（模块顶层零 DOM 契约）
 *  - index.html 结构断言：入口位于模型页侧栏（#model-side-actions），不在页头
 *
 * 浏览器内 href 精化（启动拉取 /api/account/status）由浏览器手工验收。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const mod = await import('../src/web/public/app.js')
const { buildCfDynamicRoutesUrl, CF_GATEWAY_FALLBACK_URL, applyCfRoutesLink } = mod

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

// ── 1：配置齐全 → 直达网关动态路由页 ──────────────────────
section('buildCfDynamicRoutesUrl 配置齐全')
const url = buildCfDynamicRoutesUrl('abc123', 'cf-ai-gateway')
check(
  url === 'https://dash.cloudflare.com/abc123/ai/ai-gateway/gateways/cf-ai-gateway/routing',
  '齐全 → https://dash.cloudflare.com/<accountId>/ai/ai-gateway/gateways/<gatewayId>/routing',
)

// ── 2：未配置 / 缺失 → 回退列表页 ─────────────────────────
section('buildCfDynamicRoutesUrl 回退')
const FALLBACK = CF_GATEWAY_FALLBACK_URL
check(FALLBACK === 'https://dash.cloudflare.com/?to=/:account/ai/ai-gateway', 'CF_GATEWAY_FALLBACK_URL 常量正确')
check(buildCfDynamicRoutesUrl('未配置', '未配置') === FALLBACK, '「未配置」占位 → 回退列表页')
check(buildCfDynamicRoutesUrl('未配置', 'cf-ai-gateway') === FALLBACK, 'accountId 占位 → 回退列表页')
check(buildCfDynamicRoutesUrl('abc123', '未配置') === FALLBACK, 'gatewayId 占位 → 回退列表页')
check(buildCfDynamicRoutesUrl('', '') === FALLBACK, '空串 → 回退列表页')
check(buildCfDynamicRoutesUrl('  ', '  ') === FALLBACK, '空白串 → 回退列表页')
check(buildCfDynamicRoutesUrl(undefined, undefined) === FALLBACK, 'undefined → 回退列表页')
check(buildCfDynamicRoutesUrl(null, null) === FALLBACK, 'null → 回退列表页')
check(buildCfDynamicRoutesUrl(123, 456) === FALLBACK, '非字符串 → 回退列表页')

// ── 3：URL 转义 ───────────────────────────────────────────
section('buildCfDynamicRoutesUrl 转义')
const esc = buildCfDynamicRoutesUrl('a b/c', 'gw?x=1')
check(esc.includes('a%20b%2Fc') && esc.includes('gw%3Fx%3D1'), '特殊字符按 encodeURIComponent 转义')

// ── 4：Node 无 DOM 安全性 ─────────────────────────────────
section('applyCfRoutesLink 无 DOM')
let noThrow = true
try {
  applyCfRoutesLink({ accountId: 'abc123', gatewayId: 'cf-ai-gateway' })
  applyCfRoutesLink(null)
  applyCfRoutesLink()
} catch {
  noThrow = false
}
check(noThrow, 'Node 无 DOM 环境调用安全 no-op（模块顶层零 DOM 契约）')

// ── 5：index.html 结构断言（入口位置 + 文案契约）─────────
section('index.html 结构断言')
const html = await readFile(path.join(ROOT, 'src', 'web', 'public', 'index.html'), 'utf8')
const sideActionsStart = html.indexOf('<div id="model-side-actions"')
const sideActionsEnd = html.indexOf('</aside>')
check(sideActionsStart !== -1 && sideActionsEnd !== -1, '#model-side-actions 侧栏存在')
check(
  sideActionsStart !== -1 &&
    html.slice(sideActionsStart, sideActionsEnd).includes('id="cf-routes-link"'),
  '动态路由入口 #cf-routes-link 位于模型页侧栏内',
)
check(
  html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'),
  '外链保留新窗口打开 + noopener 安全属性',
)
check(html.includes('动态路由'), '入口文案为「动态路由」')
check(!html.slice(0, sideActionsStart).includes('cf-routes-link'), '页头不再包含该入口（已从页头移除）')
check(html.includes('/?to=/:account/ai/ai-gateway'), '回退链接指向 AI Gateway 列表页')

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
