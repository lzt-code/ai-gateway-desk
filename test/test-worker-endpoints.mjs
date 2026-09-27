/**
 * Worker 地址自动发现纯逻辑测试：
 * buildWorkersDevUrl / routePatternToBaseUrl / discoverWorkerEndpoints（注入 mock API）
 */

import {
  buildWorkersDevUrl,
  parseRoutePattern,
  routePatternToBaseUrl,
  matchProxiedSubdomains,
  discoverWorkerEndpoints,
} from '../src/cloudflare/worker-endpoints.js'

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

section('1. buildWorkersDevUrl')
{
  check(
    buildWorkersDevUrl('my-sub') === 'https://ai-gateway-desk-worker.my-sub.workers.dev',
    '拼默认地址'
  )
  check(buildWorkersDevUrl('  ') === '', '空白子域 → 空串')
  check(buildWorkersDevUrl('') === '', '空子域 → 空串')
  check(
    buildWorkersDevUrl('my-sub', 'other-worker') === 'https://other-worker.my-sub.workers.dev',
    '自定义脚本名'
  )
}

section('2. routePatternToBaseUrl')
{
  check(
    routePatternToBaseUrl('*.laoliu-dev.uk/api/*') === 'https://<子域>.laoliu-dev.uk/api/v1',
    '通配符 host + 路径前缀'
  )
  check(
    routePatternToBaseUrl('ai.example.com/v1/*') === 'https://ai.example.com/v1/v1',
    '具体 host + 路径（保留前缀，末尾补 v1）'
  )
  check(
    routePatternToBaseUrl('ai.example.com/*') === 'https://ai.example.com/v1',
    '具体 host 根路径'
  )
  check(
    routePatternToBaseUrl('ai.example.com') === 'https://ai.example.com/v1',
    '无路径模式'
  )
  check(
    routePatternToBaseUrl('*.example.com/api') === 'https://<子域>.example.com/api/v1',
    '通配符 + 无尾部星号路径'
  )
  check(routePatternToBaseUrl('') === '', '空模式 → 空串')
  check(routePatternToBaseUrl('a*.example.com/*') === '', '非法中段通配符 → 空串')
  check(
    routePatternToBaseUrl('*.laoliu-dev.uk/api/*', 'aigw.laoliu-dev.uk') ===
      'https://aigw.laoliu-dev.uk/api/v1',
    'hostOverride 解析通配符子域'
  )
  check(
    routePatternToBaseUrl('ai.example.com/*', 'ignored.example.com') ===
      'https://ai.example.com/v1',
    '非通配符模式忽略 hostOverride'
  )
}

section('2b. parseRoutePattern')
{
  check(JSON.stringify(parseRoutePattern('*.example.com/api/*')) === JSON.stringify({ host: 'example.com', wildcard: true, pathPrefix: '/api' }), '通配符 host')
  check(parseRoutePattern('*')?.wildcard === true && parseRoutePattern('*')?.host === '', '裸 * → host 空')
  check(parseRoutePattern('ai.example.com/*')?.wildcard === false, '具体 host 非通配')
  check(parseRoutePattern('a*.example.com/*') === null, '非法中段通配符 → null')
  check(parseRoutePattern('') === null, '空串 → null')
}

section('2c. matchProxiedSubdomains')
{
  const records = [
    { name: 'aigw.laoliu-dev.uk', proxied: true },
    { name: 'api.laoliu-dev.uk', proxied: true },
    { name: 'laoliu-dev.uk', proxied: true },
    { name: 'plain.laoliu-dev.uk', proxied: false },
    { name: '*.laoliu-dev.uk', proxied: true },
    { name: 'x.other.com', proxied: true },
  ]
  const r = matchProxiedSubdomains('laoliu-dev.uk', 'laoliu-dev.uk', records)
  check(
    JSON.stringify(r.subdomains) === JSON.stringify(['aigw.laoliu-dev.uk', 'api.laoliu-dev.uk']),
    '仅取 zone 下已代理严格子域（排除 apex/未代理/异域）'
  )
  check(r.wildcardDns === true, '识别通配 DNS 记录')

  const noWildcard = matchProxiedSubdomains('api.laoliu-dev.uk', 'laoliu-dev.uk', [
    { name: 'x.api.laoliu-dev.uk', proxied: true },
    { name: 'api.laoliu-dev.uk', proxied: true },
  ])
  check(JSON.stringify(noWildcard.subdomains) === JSON.stringify(['x.api.laoliu-dev.uk']), '更深层通配仅取严格子域')

  const bare = matchProxiedSubdomains('', 'laoliu-dev.uk', records)
  check(!bare.subdomains.includes('laoliu-dev.uk'), '裸 * 路由排除 zone 根域')
  check(bare.wildcardDns === true, '裸 * 路由识别通配 DNS')
}

const noopZones = {
  getZones: async () => [],
}

section('3. discoverWorkerEndpoints：全部就绪')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => 'my-sub',
    getScriptEnabled: async () => true,
    getDomains: async () => ['ai.example.com', 'gw.example.org'],
    getZones: async () => [{ id: 'z1', name: 'laoliu-dev.uk' }],
    getRoutes: async () => ['*.laoliu-dev.uk/api/*'],
    getDnsRecords: async () => [
      { name: 'aigw.laoliu-dev.uk', proxied: true },
      { name: '*.laoliu-dev.uk', proxied: true },
      { name: 'laoliu-dev.uk', proxied: true },
    ],
  })
  check(
    r.workersDev === 'https://ai-gateway-desk-worker.my-sub.workers.dev',
    'workersDev 正确'
  )
  check(r.customDomains.length === 2, '2 个自定义域名')
  check(r.routes[0] === 'https://aigw.laoliu-dev.uk/api/v1', '通配符路由自动解析为真实子域')
  check(r.notes.length === 0, '解析成功无降级提示')
  check(r.error === '', '无错误')
}

section('4. discoverWorkerEndpoints：workers.dev 未开启')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => 'my-sub',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    ...noopZones,
  })
  check(r.workersDev === '', 'enabled=false → workersDev 空')
  check(r.customDomains.length === 0, '无自定义域名')
  check(r.routes.length === 0, '无路由')
  check(r.error === '', '不算错误')
}

section('5. discoverWorkerEndpoints：账户无子域但已开启')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => true,
    getDomains: async () => ['ai.example.com'],
    ...noopZones,
  })
  check(r.workersDev === '', '子域为空 → workersDev 空')
  check(r.customDomains[0] === 'ai.example.com', '自定义域名仍返回')
}

section('6. discoverWorkerEndpoints：脚本未部署（404）')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => 'my-sub',
    getScriptEnabled: async () => {
      const err = new Error('10091: workers.api.error.script_not_found')
      err.status = 404
      throw err
    },
    getDomains: async () => [],
    ...noopZones,
  })
  check(r.workersDev === '', 'workersDev 空')
  check(r.customDomains.length === 0, '自定义域名空')
  check(r.error.includes('not_found'), '错误被记录')
}

section('7. discoverWorkerEndpoints：部分失败隔离')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => {
      throw new Error('boom-subdomain')
    },
    getScriptEnabled: async () => true,
    getDomains: async () => {
      throw new Error('boom-domains')
    },
    getZones: async () => {
      throw new Error('boom-zones')
    },
  })
  check(r.workersDev === '', 'workers.dev 段失败 → 空')
  check(r.customDomains.length === 0, '域名段失败 → 空')
  check(r.routes.length === 0, '路由段失败 → 空')
  check(r.error.includes('boom-subdomain'), '含 workers.dev 错误')
  check(r.error.includes('boom-domains'), '含域名错误')
  check(r.error.includes('boom-zones'), '含路由错误')
}

section('8. discoverWorkerEndpoints：多 zone 仅取本脚本路由')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    getZones: async () => [
      { id: 'z1', name: 'a.com' },
      { id: 'z2', name: 'b.com' },
    ],
    getRoutes: async (token, zoneId) =>
      zoneId === 'z1' ? ['api.a.com/v1/*'] : [],
  })
  check(r.routes.length === 1, '只收集有匹配的 zone')
  check(r.routes[0] === 'https://api.a.com/v1/v1', '地址正确')
}

section('9. discoverWorkerEndpoints：通配符无代理记录 → 占位 + 提示')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    getZones: async () => [{ id: 'z1', name: 'laoliu-dev.uk' }],
    getRoutes: async () => ['*.laoliu-dev.uk/api/*'],
    getDnsRecords: async () => [{ name: 'laoliu-dev.uk', proxied: true }],
  })
  check(r.routes[0] === 'https://<子域>.laoliu-dev.uk/api/v1', '无具体子域 → 保留占位')
  check(r.notes.length === 1 && r.notes[0].includes('未找到已代理'), '提示缺代理记录')
  check(r.error === '', '不写入 error')
}

section('10. discoverWorkerEndpoints：仅通配 DNS 记录 → 占位 + 任意子域提示')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    getZones: async () => [{ id: 'z1', name: 'laoliu-dev.uk' }],
    getRoutes: async () => ['*.laoliu-dev.uk/api/*'],
    getDnsRecords: async () => [{ name: '*.laoliu-dev.uk', proxied: true }],
  })
  check(r.routes[0].includes('<子域>'), '仍为占位')
  check(r.notes[0].includes('任意子域'), '提示任意子域可用')
}

section('11. discoverWorkerEndpoints：DNS 403 → 降级提示补权限')
{
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    getZones: async () => [{ id: 'z1', name: 'laoliu-dev.uk' }],
    getRoutes: async () => ['*.laoliu-dev.uk/api/*'],
    getDnsRecords: async () => {
      const err = new Error('403: Forbidden')
      err.status = 403
      throw err
    },
  })
  check(r.routes[0].includes('<子域>'), '占位保留')
  check(r.notes[0].includes('Zone → DNS → Read'), '提示补充 DNS Read 权限')
  check(r.error === '', '非致命，不计入 error')
}

section('12. discoverWorkerEndpoints：具体 host 不触发 DNS 查询')
{
  let dnsCalled = false
  const r = await discoverWorkerEndpoints('tok', 'acc', {
    getSubdomain: async () => '',
    getScriptEnabled: async () => false,
    getDomains: async () => [],
    getZones: async () => [{ id: 'z1', name: 'a.com' }],
    getRoutes: async () => ['api.a.com/v1/*'],
    getDnsRecords: async () => {
      dnsCalled = true
      return []
    },
  })
  check(dnsCalled === false, '无通配符不查 DNS')
  check(r.routes[0] === 'https://api.a.com/v1/v1', '具体 host 地址正确')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
