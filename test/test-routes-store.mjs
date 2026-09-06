/**
 * routes-store（data/routes.json 读写 + upsert/remove 纯函数）验证脚本
 *
 * 覆盖：文件缺失回退空骨架 / 损坏文件容错 / 写入后可读回 /
 * upsert 保留既有字段（cloudId 等）/ remove 不影响其他条目 / dataDir 重定向隔离
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadRoutesStore, saveRoutesStore, upsertRoute, removeRoute } from '../src/core/routes-store.js'

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

const dir = mkdtempSync(path.join(tmpdir(), 'aigd-routes-test-'))
try {
  // ── 1：文件缺失 → 空骨架 ────────────────────────────────
  section('文件缺失 / 损坏容错')
  check(JSON.stringify(loadRoutesStore(dir)) === JSON.stringify({ routes: {} }), '文件缺失 → { routes: {} }')
  writeFileSync(path.join(dir, 'routes.json'), 'not-json{', 'utf-8')
  check(JSON.stringify(loadRoutesStore(dir)) === JSON.stringify({ routes: {} }), '损坏 JSON → 容错为空骨架（不抛错）')
  writeFileSync(path.join(dir, 'routes.json'), '{"routes":{"a":{"name":"a"}},"extra":1}', 'utf-8')
  const parsed = loadRoutesStore(dir)
  check(parsed.routes.a && parsed.extra === 1, '合法文件原样读回（不清洗额外字段）')
  writeFileSync(path.join(dir, 'routes.json'), '{"no-routes":true}', 'utf-8')
  check(JSON.stringify(loadRoutesStore(dir)) === JSON.stringify({ routes: {} }), '缺 routes 键 → 空骨架')

  // ── 2：写入 / 读回 ──────────────────────────────────────
  section('写入 / 读回')
  saveRoutesStore({ routes: { support: { name: 'support', elements: [], dirty: true } } }, dir)
  const back = loadRoutesStore(dir)
  check(back.routes.support && back.routes.support.dirty === true, '写入后读回一致')

  // ── 3：目录不存在时自动创建 ─────────────────────────────
  section('目录自动创建')
  const nested = path.join(dir, 'sub', 'data')
  saveRoutesStore({ routes: {} }, nested)
  check(loadRoutesStore(nested) !== null, '嵌套目录自动创建并写入成功')

  // ── 4：upsert / remove 纯函数 ───────────────────────────
  section('upsert / remove 纯函数')
  const store = { routes: { support: { name: 'support', elements: [1], cloudId: 'uuid-1', dirty: false } } }
  const next = upsertRoute(store, 'support', { elements: [2], dirty: true })
  check(next.routes.support.elements.length === 1 && next.routes.support.dirty === true,
    'upsert 覆盖指定字段（elements/dirty）')
  check(next.routes.support.cloudId === 'uuid-1', 'upsert 保留既有字段（cloudId）')
  check(store.routes.support.elements.length === 1 && store.routes.support.dirty === false,
    'upsert 不改入参 store（纯函数）')
  const added = upsertRoute(store, 'other', { elements: [] })
  check(added.routes.other.name === 'other', 'upsert 新条目自动带 name')
  const removed = removeRoute(added, 'support')
  check(!removed.routes.support && removed.routes.other, 'remove 删除目标条目且不影响其他')
  check(JSON.stringify(removeRoute(null, 'x')) === JSON.stringify({ routes: {} }), 'remove(null) 安全返回空骨架')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
