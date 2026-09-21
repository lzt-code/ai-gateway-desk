/**
 * Worker 地址自动发现纯逻辑测试：
 * buildWorkersDevUrl / routePatternToBaseUrl / discoverWorkerEndpoints（注入 mock API）
 */

import {
  buildWorkersDevUrl,
  routePatternToBaseUrl,
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
  })
  check(
    r.workersDev === 'https://ai-gateway-desk-worker.my-sub.workers.dev',
    'workersDev 正确'
  )
  check(r.customDomains.length === 2, '2 个自定义域名')
  check(r.routes[0] === 'https://<子域>.laoliu-dev.uk/api/v1', '路由地址推导正确')
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

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
