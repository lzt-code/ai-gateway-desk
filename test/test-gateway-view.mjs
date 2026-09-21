/**
 * 双网关「网关」视图纯函数测试：
 * buildLocalGatewayCard / buildCloudWorkerCard /
 * buildGatewayModeSwitch / buildProviderKeysTable / buildGatewayView
 */

import {
  buildLocalGatewayCard,
  buildCloudWorkerCard,
  buildGatewayModeSwitch,
  buildProviderKeysTable,
  buildGatewayView,
  GATEWAY_MODE_TEXT,
} from '../src/web/public/app.js'

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

const overview = {
  running: true,
  mode: 'local',
  port: 8788,
  cloudWorkerUrl: 'https://w.example.com',
  baseUrl: 'http://127.0.0.1:8788/v1',
  providers: [
    { slug: 'custom-fang-zhou', id: 'fang-zhou', name: '方舟', type: 'custom-provider', keySaved: true },
    { slug: 'openai', id: 'openai', name: 'OpenAI', type: 'byok', keySaved: false, needsReEntry: true },
  ],
}

section('1. buildLocalGatewayCard')
{
  const html = buildLocalGatewayCard(overview)
  check(html.includes('本地网关'), '标题')
  check(html.includes('运行中'), '运行中状态')
  check(html.includes(GATEWAY_MODE_TEXT.local), '模式文案')
  check(html.includes('127.0.0.1:8788'), '监听地址')
  check(html.includes('http://127.0.0.1:8788/v1'), 'Base URL')
  check(html.includes('btn-copy-baseurl'), '复制按钮')

  const stopped = buildLocalGatewayCard({ ...overview, running: false })
  check(stopped.includes('未运行'), '未运行状态')
  check(stopped.includes('aigd gateway'), '提示启动命令')
}

section('2. buildCloudWorkerCard')
{
  const html = buildCloudWorkerCard(overview)
  check(html.includes('云端 Worker'), '标题')
  check(html.includes('https://w.example.com'), 'Worker 地址')
  check(html.includes('btn-edit-cloudurl'), '编辑按钮')
  check(html.includes('btn-deploy-worker'), '部署按钮')

  const empty = buildCloudWorkerCard({ ...overview, cloudWorkerUrl: '' })
  check(empty.includes('未配置'), '空地址 → 未配置')
}

section('3. buildGatewayModeSwitch')
{
  const html = buildGatewayModeSwitch(overview)
  check(html.includes('全局模式'), '标题')
  const localBtn = html.match(/data-mode="local"[^>]*class="[^"]*"|class="[^"]*"[^>]*data-mode="local"/)
  check(html.includes('data-mode="local"'), '本地模式按钮')
  check(html.includes('data-mode="cloud"'), '云端模式按钮')
  check(html.includes('btn-backfill-keys'), '回填按钮')
  check(html.includes('btn-primary'), '当前选中模式为主按钮')

  const cloudView = buildGatewayModeSwitch({ ...overview, mode: 'cloud' })
  const cloudBtnSegment = cloudView
    .split('data-mode="cloud"')[1]
    ?.slice(0, 80)
  check(
    cloudView
      .split('data-mode="cloud"')[0]
      .includes('btn-primary'),
    'cloud 模式下 cloud 按钮为主样式'
  )
}

section('4. buildProviderKeysTable')
{
  const html = buildProviderKeysTable(overview)
  check(html.includes('本地凭证'), '标题')
  check(html.includes('方舟'), 'provider 名称')
  check(html.includes('已保存'), '已保存状态')
  check(html.includes('需重新录入'), 'BYOK 需重新录入')
  check(html.includes('btn-rekey'), '录入/覆盖按钮')
  check(html.includes('data-slug="openai"'), '行携带 slug')

  const empty = buildProviderKeysTable({ providers: [] })
  check(empty.includes('<tbody></tbody>'), '空列表 tbody 为空')
}

section('5. buildGatewayView 聚合')
{
  const html = buildGatewayView(overview)
  check(html.includes('本地网关'), '含本地网关卡')
  check(html.includes('云端 Worker'), '含云端 Worker 卡')
  check(html.includes('全局模式'), '含模式开关')
  check(html.includes('本地凭证'), '含凭证表')
}

section('6. XSS 转义')
{
  const evil = {
    ...overview,
    providers: [
      { slug: 'x', id: 'x', name: '<script>alert(1)</script>', type: 'custom-provider', keySaved: false },
    ],
  }
  const html = buildProviderKeysTable(evil)
  check(!html.includes('<script>alert(1)</script>'), '名称被转义')
  check(html.includes('&lt;script&gt;'), '转义为实体')

  const evilUrl = buildCloudWorkerCard({
    ...overview,
    cloudWorkerUrl: '"><img src=x onerror=alert(1)>',
  })
  check(!evilUrl.includes('onerror=alert(1)>'), 'URL 被转义')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
