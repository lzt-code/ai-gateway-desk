/**
 * 网关配置存储测试 — data/gateway.json 读写、默认值、字段校验
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  defaultGatewayConfig,
  loadGatewayConfig,
  saveGatewayConfig,
  validateGatewayConfig,
  normalizePort,
  normalizeMode,
  normalizeCloudWorkerUrl,
} from '../src/gateway/config-store.js'

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

function expectThrow(fn, fragment) {
  try {
    fn()
    return false
  } catch (err) {
    return !fragment || err.message.includes(fragment)
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'aigd-gw-config-'))

try {
  section('1. 默认值')
  const d = defaultGatewayConfig()
  check(d.mode === 'local', `默认 mode=local（实际 ${d.mode}）`)
  check(d.port === 8788, `默认 port=8788（实际 ${d.port}）`)
  check(d.cloudWorkerUrl === '', '默认 cloudWorkerUrl 为空串')

  section('2. 文件缺失 / 损坏回退默认值')
  check(loadGatewayConfig(dir).mode === 'local', '文件缺失 → 默认配置')
  writeFileSync(path.join(dir, 'gateway.json'), 'not-json{')
  check(loadGatewayConfig(dir).port === 8788, 'JSON 损坏 → 默认配置')

  section('3. 读写 round-trip')
  const saved = saveGatewayConfig(
    { mode: 'cloud', port: 9999, cloudWorkerUrl: 'https://w.example.com' },
    dir
  )
  check(saved.port === 9999, 'save 返回归一化配置')
  const loaded = loadGatewayConfig(dir)
  check(loaded.mode === 'cloud', '读回 mode=cloud')
  check(loaded.port === 9999, '读回 port=9999')
  check(loaded.cloudWorkerUrl === 'https://w.example.com', '读回 cloudWorkerUrl')

  section('4. 部分配置与默认值合并')
  writeFileSync(path.join(dir, 'gateway.json'), JSON.stringify({ mode: 'cloud' }))
  check(loadGatewayConfig(dir).port === 8788, '缺 port → 补默认 8788')
  check(loadGatewayConfig(dir).cloudWorkerUrl === '', '缺 cloudWorkerUrl → 空串')
  check(
    JSON.stringify(validateGatewayConfig(undefined)) === JSON.stringify(defaultGatewayConfig()),
    'validate(undefined) → 默认值'
  )

  section('5. 字段校验')
  check(expectThrow(() => normalizeMode('nope'), "'local'"), '非法 mode 抛错')
  check(normalizeMode('cloud') === 'cloud', '合法 mode 通过')
  check(normalizePort('8000') === 8000, '数字字符串端口归一化')
  check(expectThrow(() => normalizePort(0), '1–65535'), 'port=0 抛错')
  check(expectThrow(() => normalizePort(70000), '1–65535'), 'port=70000 抛错')
  check(expectThrow(() => normalizePort('abc'), '1–65535'), '非数字端口抛错')
  check(normalizeCloudWorkerUrl('') === '', '空 cloudWorkerUrl 通过')
  check(
    normalizeCloudWorkerUrl(' https://x.dev/ ') === 'https://x.dev/',
    'cloudWorkerUrl trim'
  )
  check(expectThrow(() => normalizeCloudWorkerUrl('ftp://x'), 'http'), '非 http(s) URL 抛错')
  check(expectThrow(() => normalizeCloudWorkerUrl('not-url'), 'URL'), '非法 URL 抛错')
  check(expectThrow(() => validateGatewayConfig([]), '对象'), '数组配置抛错')
  check(expectThrow(() => saveGatewayConfig({ mode: 'x' }, dir), 'mode'), 'save 非法配置抛错')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
