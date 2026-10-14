/**
 * 网络瞬时失败：根因展开 + 退避重试（src/core/net-retry.js）
 *
 * 覆盖：
 *   - describeNetworkError：展开 err.cause 根因与目标主机
 *   - isRetriableNetworkError：仅连接阶段错误可重试
 *   - withNetworkRetry：重试次数 / 退避 / 非重试错误立即抛出 / onRetry 回调
 *   - 与 cloudflare/api.js 集成：createGateway 连接超时后重试成功；最终失败带根因
 *
 * 全程 mock 全局 fetch，零触网。
 */

import {
  describeNetworkError,
  isRetriableNetworkError,
  withNetworkRetry,
} from '../src/core/net-retry.js'
import { createGateway } from '../src/cloudflare/api.js'

let failures = 0
let checks = 0
function check(cond, msg) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n${name}`) }

/** 构造 undici 风格的连接超时错误 */
function connectTimeout() {
  const err = new TypeError('fetch failed')
  err.cause = { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'Connect Timeout Error (attempted addresses: 104.19.192.29:443, timeout: 10000ms)' }
  return err
}

// ── 纯函数：根因展开 ─────────────────────────────────────

section('describeNetworkError')
{
  check(describeNetworkError(connectTimeout(), 'https://api.cloudflare.com/client/v4/accounts') ===
    'fetch failed（UND_ERR_CONNECT_TIMEOUT @ api.cloudflare.com）', '展开根因 + 主机')

  const plain = new TypeError('fetch failed')
  check(describeNetworkError(plain, 'https://api.cloudflare.com/x').includes('fetch failed') &&
    describeNetworkError(plain, 'https://api.cloudflare.com/x').includes('api.cloudflare.com'), '无 cause → 仍带主机')

  check(describeNetworkError(connectTimeout(), 'not-a-url') ===
    'fetch failed（UND_ERR_CONNECT_TIMEOUT）', '非法 URL → 不展示主机')
}

// ── 纯函数：可重试判定 ───────────────────────────────────

section('isRetriableNetworkError')
{
  check(isRetriableNetworkError(connectTimeout()) === true, 'UND_ERR_CONNECT_TIMEOUT → 可重试')

  const notFound = new TypeError('fetch failed')
  notFound.cause = { code: 'ENOTFOUND' }
  check(isRetriableNetworkError(notFound) === true, 'ENOTFOUND → 可重试')

  const reset = new TypeError('fetch failed')
  reset.cause = { code: 'ECONNRESET' }
  check(isRetriableNetworkError(reset) === false, 'ECONNRESET（可能已发出请求）→ 不重试')

  check(isRetriableNetworkError(new Error('请求超时 (10s)')) === false, '普通超时（无 cause）→ 不重试')
  check(isRetriableNetworkError(null) === false, 'null → false')
}

// ── withNetworkRetry ─────────────────────────────────────

section('withNetworkRetry')
{
  // 连接超时 → 第 3 次成功
  let n = 0
  const retries = []
  const r = await withNetworkRetry(
    async () => {
      n++
      if (n < 3) throw connectTimeout()
      return 'ok'
    },
    { retries: 2, baseDelayMs: 1, onRetry: (info) => retries.push(info) }
  )
  check(r === 'ok' && n === 3, '连接超时重试至成功（共 3 次尝试）')
  check(retries.length === 2 && retries[0].attempt === 1 && retries[0].waitMs === 1, 'onRetry 回调收到尝试序号与等待时长')

  // 持续失败 → 抛出，且尝试次数 = retries+1
  let m = 0
  let threw = false
  try {
    await withNetworkRetry(async () => { m++; throw connectTimeout() }, { retries: 1, baseDelayMs: 1 })
  } catch (e) { threw = e.cause && e.cause.code === 'UND_ERR_CONNECT_TIMEOUT' }
  check(threw && m === 2, '持续失败 → 抛出原始错误，尝试 retries+1 次')

  // 非重试错误 → 立即抛出，不重试
  let k = 0
  threw = false
  try {
    await withNetworkRetry(async () => { k++; throw new Error('业务错误') }, { retries: 2, baseDelayMs: 1 })
  } catch (e) { threw = e.message === '业务错误' }
  check(threw && k === 1, '非连接类错误 → 不重试，立即抛出')
}

// ── 集成：api.js createGateway ────────────────────────────

section('createGateway 网络重试')
{
  const originalFetch = globalThis.fetch

  // 首次连接超时 → 重试成功
  {
    let n = 0
    globalThis.fetch = async () => {
      n++
      if (n === 1) throw connectTimeout()
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ success: true, result: { id: 'gw' } }) }
    }
    try {
      const r = await createGateway('tok', 'acc', 'gw')
      check(r && r.id === 'gw', '连接超时后重试成功')
      check(n === 2, '发生 1 次重试（共 2 次请求）')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 持续连接超时 → 抛错并带根因 + 主机
  {
    globalThis.fetch = async () => { throw connectTimeout() }
    try {
      let msg = ''
      try {
        await createGateway('tok', 'acc', 'gw')
        check(false, '持续失败应抛错')
      } catch (e) {
        msg = e.message
      }
      check(msg.includes('UND_ERR_CONNECT_TIMEOUT') && msg.includes('api.cloudflare.com'),
        '最终错误文案含根因与主机，而非笼统 "fetch failed"')
    } finally {
      globalThis.fetch = originalFetch
    }
  }
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
