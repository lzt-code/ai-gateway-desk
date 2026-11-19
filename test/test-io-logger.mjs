/**
 * io-logger 脱敏与日志缓冲验证脚本
 *
 * 重点：日志会落盘/推送到前端，token / secret / Authorization 头绝不能明文出现。
 * 覆盖 maskToken（长短 token）、maskHeaders（Authorization 头）、maskBody（JSON 字段递归）。
 */

import {
  maskToken,
  maskHeaders,
  maskBody,
  getRecentLogs,
  clearLogs,
  logResult,
} from '../src/core/io-logger.js'

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

section('maskToken')
{
  check(maskToken('abc') === '***', '短 token（<=8）→ 全星号（长度一致）')
  check(maskToken('') === '****', '空 token → ****')

  const secret = 'cfut_abcdefghijklmnop'
  const masked = maskToken(secret)
  check(masked.startsWith('cfut') && masked.endsWith('mnop'), '长 token 保留首 4 位与末 4 位')
  check(!masked.includes('abcdefghij'), '长 token 中段被星号替换（无明文）')
  check(masked !== secret, '长 token 不等于原文')
}

section('maskHeaders')
{
  const secret = 'sk-secret-1234567890'
  const masked = maskHeaders({ Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' })
  check(masked.Authorization.startsWith('Bearer '), '保留 Bearer 前缀')
  check(!masked.Authorization.includes(secret), 'Authorization 头中的 token 不明文出现')
  check(masked.Authorization.includes('*'), 'Authorization 头已打码')
  check(masked['Content-Type'] === 'application/json', '非鉴权头原样保留')

  const lower = maskHeaders({ authorization: secret })
  check(!lower.authorization.includes(secret), '小写 authorization 同样打码')
}

section('maskBody')
{
  const secret = 'super-secret-key-123'
  const apiKey = 'tok_abcdefghijkl'
  const raw = JSON.stringify({
    model: 'gpt',
    apiKey: secret,
    nested: { token: apiKey, note: 'ok' },
  })
  const out = maskBody(raw)
  check(!out.includes(secret), 'JSON 字符串中的 apiKey 不明文出现')
  check(!out.includes(apiKey), '嵌套对象中的 token 不明文出现')
  check(out.includes('"model":"gpt"') && out.includes('"note":"ok"'), '非敏感字段保留')

  const longText = 'x'.repeat(2000)
  const truncated = maskBody(longText)
  check(typeof truncated === 'string' && truncated.length <= 1000, '非 JSON 长文本按预览上限截断')
}

section('日志环形缓冲')
{
  clearLogs()
  for (let i = 0; i < 3; i++) logResult('test:op', { ok: true, message: `m${i}`, elapsedMs: 1 })
  check(getRecentLogs(2).length === 2, 'getRecentLogs(limit) 返回最近 n 条')
  check(getRecentLogs().length === 3, '默认返回缓冲内全部（< 上限）')
  clearLogs()
  check(getRecentLogs().length === 0, 'clearLogs 清空缓冲')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
