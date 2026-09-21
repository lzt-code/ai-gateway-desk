/**
 * 厂商凭证本地加密存储测试 — 按 slug 读写 / 覆盖 / 删除 / has
 * 经 AI_GW_TEST_DIR 隔离，不触碰真实凭证存储。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TEST_DIR = mkdtempSync(path.join(tmpdir(), 'aigd-gw-keys-'))
process.env.AI_GW_TEST_DIR = TEST_DIR

const {
  writeProviderHeaders,
  readProviderHeaders,
  deleteProviderHeaders,
  hasProviderKey,
} = await import('../src/gateway/provider-keys.js')

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

try {
  section('1. 未保存状态')
  check(readProviderHeaders('custom-ark') === null, '未保存 → null')
  check(hasProviderKey('custom-ark') === false, 'hasProviderKey=false')

  section('2. 写入与读取（支持自定义鉴权头）')
  writeProviderHeaders('custom-ark', {
    Authorization: 'Bearer sk-secret-123',
    'X-Custom-Auth': 'abc',
  })
  const h = readProviderHeaders('custom-ark')
  check(h !== null && h.Authorization === 'Bearer sk-secret-123', '读回 Authorization 完整值')
  check(h['X-Custom-Auth'] === 'abc', '读回自定义头')
  check(hasProviderKey('custom-ark') === true, 'hasProviderKey=true')

  section('3. 覆盖写')
  writeProviderHeaders('custom-ark', { Authorization: 'Bearer sk-new-456' })
  check(
    readProviderHeaders('custom-ark').Authorization === 'Bearer sk-new-456',
    '覆盖后读回新值'
  )

  section('4. 多 slug 独立存储（子路径）')
  writeProviderHeaders('openrouter', { Authorization: 'Bearer or-key' })
  check(
    readProviderHeaders('openrouter').Authorization === 'Bearer or-key',
    'openrouter 独立凭证可读'
  )
  check(
    readProviderHeaders('custom-ark').Authorization === 'Bearer sk-new-456',
    'custom-ark 凭证不受影响'
  )

  section('5. 删除')
  deleteProviderHeaders('custom-ark')
  check(readProviderHeaders('custom-ark') === null, '删除后 → null')
  check(hasProviderKey('custom-ark') === false, '删除后 has=false')
  check(hasProviderKey('openrouter') === true, '删除不影响其他 slug')

  section('6. 非法参数')
  let threw = false
  try {
    writeProviderHeaders('BAD_SLUG', { Authorization: 'x' })
  } catch {
    threw = true
  }
  check(threw, '非法 slug 抛错')
  threw = false
  try {
    writeProviderHeaders('custom-x', {})
  } catch {
    threw = true
  }
  check(threw, '空 headers 抛错')
  threw = false
  try {
    writeProviderHeaders('custom-x', { Authorization: 123 })
  } catch {
    threw = true
  }
  check(threw, '非字符串 header 值抛错')
} finally {
  rmSync(TEST_DIR, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
