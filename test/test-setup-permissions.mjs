/**
 * 向导权限清单一致性验证脚本
 *
 * 目的：防止「账户页所需权限清单」（src/cloudflare/token-info.js 的
 * REQUIRED_PERMISSIONS）与「初始化向导第 1 步的权限引导」
 * （src/setup.js 的 G.mgmt 权限条目）发生漂移 —— 任一侧新增 / 改名 / 改必需性，
 * 另一方若没同步，本测试立即失败。
 *
 * 做法：直接读 setup.js 源码，抽出权限条目行（含 “·” 与 “→” 的字符串），
 * 解析为 { group, accessPart }，再与 REQUIRED_PERMISSIONS 双向比对：
 *   1) 每条所需权限都能在向导里找到（不漏项）
 *   2) 每条向导条目都对应一条所需权限（不擅自多加）
 *   3) 必需 / 可选 标注与账户页 required 字段一致
 *
 * 纯文本解析，零触网、零副作用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { REQUIRED_PERMISSIONS } from '../src/cloudflare/token-info.js'

const ROOT = path.resolve(import.meta.dirname, '..')
const SETUP_PATH = path.join(ROOT, 'src', 'setup.js')

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

/** 转义正则特殊字符 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从向导源码抽取权限条目：
 * 形如 `'     · Account → AI Gateway         → Edit（…）',`
 * → { group: 'AI Gateway', accessPart: 'Edit（…）' }
 * @param {string} src - setup.js 源码
 * @returns {Array<{ group: string, accessPart: string }>}
 */
function extractWizardPermissions(src) {
  const out = []
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith("'")) continue
    if (!line.includes('·') || !line.includes('→')) continue
    const inner = line.replace(/^'/, '').replace(/',\s*$/, '').replace(/'$/, '')
    const seg = inner.split('→').map((s) => s.trim())
    if (seg.length < 3) continue
    const group = seg[1]
    const accessPart = seg[2]
    if (!group || !accessPart) continue
    out.push({ group, accessPart })
  }
  return out
}

/** accessPart 是否以指定访问级别开头（如 'Edit（…）' 以 Edit 开头） */
function startsWithAccess(accessPart, access) {
  return new RegExp(`^${escapeRe(access)}\\b`, 'i').test(accessPart)
}

const src = fs.readFileSync(SETUP_PATH, 'utf8')
const bullets = extractWizardPermissions(src)

section('向导权限条目解析')
check(bullets.length > 0, `从 setup.js 解析到权限条目 ${bullets.length} 条`)
check(
  bullets.length === REQUIRED_PERMISSIONS.length,
  `条目数与账户页所需权限一致（${bullets.length} vs ${REQUIRED_PERMISSIONS.length}）`
)

// ── 1：账户页所需权限 → 向导覆盖（不漏项 + 必需/可选标注一致） ──
section('账户页所需权限 → 向导覆盖')
for (const p of REQUIRED_PERMISSIONS) {
  const hit = bullets.find(
    (b) => b.group.toLowerCase() === p.resource.toLowerCase() && startsWithAccess(b.accessPart, p.access)
  )
  check(!!hit, `${p.label} 出现在向导第 1 步`)
  if (hit) {
    const optional = hit.accessPart.includes('可选')
    check(p.required ? !optional : optional, `${p.label} 标注为「${p.required ? '必需' : '可选'}」`)
  }
}

// ── 2：向导条目 → 账户页所需权限（不擅自多加） ──
section('向导条目 → 账户页所需权限')
for (const b of bullets) {
  const hit = REQUIRED_PERMISSIONS.find(
    (p) => p.resource.toLowerCase() === b.group.toLowerCase() && startsWithAccess(b.accessPart, p.access)
  )
  check(!!hit, `向导条目「${b.group} → ${b.accessPart.slice(0, 12)}…」有对应的账户页权限`)
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)