/**
 * 网关路由纯函数测试 — slug 解析/剥离、厂商 URL 构造、BYOK 映射
 */

import {
  parseModelSlug,
  stripModelSlug,
  buildVendorUrl,
  resolveProviderEndpoint,
  normalizeBaseUrl,
  normalizePathPrefix,
  BYOK_BASE_URLS,
} from '../src/gateway/router.js'

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

section('1. parseModelSlug')
check(
  JSON.stringify(parseModelSlug('custom-ark/doubao-seed')) ===
    JSON.stringify({ slug: 'custom-ark', upstream: 'doubao-seed' }),
  '常规 slug/upstream 解析'
)
check(
  JSON.stringify(parseModelSlug('custom-v/meta/muse-1.2')) ===
    JSON.stringify({ slug: 'custom-v', upstream: 'meta/muse-1.2' }),
  'upstream 自身含 /（只按第一个 / 切）'
)
check(parseModelSlug('noslash') === null, '无 / → null')
check(parseModelSlug('/x') === null, 'slug 为空 → null')
check(parseModelSlug('x/') === null, 'upstream 为空 → null')
check(parseModelSlug(123) === null, '非字符串 → null')

section('2. stripModelSlug（不改入参）')
{
  const body = { model: 'custom-ark/doubao', x: 1 }
  const out = stripModelSlug(body, 'custom-ark')
  check(out.model === 'doubao', '剥离后 model=doubao')
  check(body.model === 'custom-ark/doubao', '入参未被修改')
  check(out.x === 1, '其他字段保留')
  const same = stripModelSlug(body, 'custom-other')
  check(same === body, '前缀不匹配 → 原样返回')
}

section('3. base_url / pathPrefix 归一化')
check(normalizeBaseUrl('https://a.com/') === 'https://a.com', '去尾部 /')
check(normalizeBaseUrl(' https://a.com/// ') === 'https://a.com', '去多个尾部 / + trim')
check(normalizePathPrefix('/api/v3/') === '/api/v3', 'pathPrefix 去尾 /')
check(normalizePathPrefix('api/v3') === '/api/v3', 'pathPrefix 补前导 /')
check(normalizePathPrefix('') === '', '空 pathPrefix → 空串')

let threw = false
try {
  normalizeBaseUrl('not-url')
} catch {
  threw = true
}
check(threw, '非法 base_url 抛错')
threw = false
try {
  normalizeBaseUrl('ftp://a.com')
} catch {
  threw = true
}
check(threw, '非 http(s) base_url 抛错')

section('4. buildVendorUrl')
check(
  buildVendorUrl('https://ark.com/', '/api/plan/v3') ===
    'https://ark.com/api/plan/v3/chat/completions',
  'base + pathPrefix + 端点'
)
check(
  buildVendorUrl('https://api.openai.com/v1') ===
    'https://api.openai.com/v1/chat/completions',
  '无 pathPrefix → base + 端点'
)
check(
  buildVendorUrl('https://ark.com///', 'api/v3/') ===
    'https://ark.com/api/v3/chat/completions',
  '两侧斜杠归一化后正确拼接'
)

section('5. resolveProviderEndpoint')
check(
  resolveProviderEndpoint({
    id: 'fang-zhou',
    type: 'custom-provider',
    base_url: 'https://ark.com/',
    pathPrefix: '/api/v3',
  }) === 'https://ark.com/api/v3/chat/completions',
  'custom-provider 使用 base_url + pathPrefix'
)
check(
  resolveProviderEndpoint({ id: 'openrouter', type: 'byok' }) ===
    `${BYOK_BASE_URLS.openrouter}/chat/completions`,
  'byok 无 base_url → 内置映射'
)
check(
  resolveProviderEndpoint({
    id: 'openrouter',
    type: 'byok',
    base_url: 'https://self.host/v1',
  }) === 'https://self.host/v1/chat/completions',
  'byok 自带 base_url → 优先自带'
)
threw = false
try {
  resolveProviderEndpoint({ id: 'weird-byok', type: 'byok' })
} catch (err) {
  threw = err.message.includes('cloud 模式')
}
check(threw, 'byok 内置未覆盖且无 base_url → 抛错提示 cloud')
threw = false
try {
  resolveProviderEndpoint({ id: 'custom-x', type: 'custom-provider' })
} catch {
  threw = true
}
check(threw, 'custom-provider 无 base_url → 抛错')

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
