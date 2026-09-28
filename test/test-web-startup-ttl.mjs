/**
 * 分层启动第二层：前端发现刷新 TTL 纯函数。
 *
 * 覆盖 isDiscoveryStale / markDiscovered：
 *  - 无记录 / 非法记录 / localStorage 不可用 → 视为需要刷新（保守）
 *  - 记录在 TTL 内 → 不刷新；超出 TTL → 刷新
 *  - markDiscovered 写入时间戳，可被 isDiscoveryStale 读回
 *
 * 通过注入 globalThis.localStorage（内存实现）在 Node 下测试，零浏览器依赖。
 */

let failures = 0
let checks = 0

function check(cond, msg) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

// 内存 localStorage mock
function makeLocalStorage() {
  const store = {}
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }
}

section('isDiscoveryStale / markDiscovered')
{
  const ls = makeLocalStorage()
  globalThis.localStorage = ls
  const mod = await import('../src/web/public/app.js')

  check(typeof mod.isDiscoveryStale === 'function', 'isDiscoveryStale 已导出')
  check(typeof mod.markDiscovered === 'function', 'markDiscovered 已导出')
  check(typeof mod.DEFAULT_DISCOVER_TTL_MS === 'number' && mod.DEFAULT_DISCOVER_TTL_MS > 0, 'DEFAULT_DISCOVER_TTL_MS 已导出为正数')
  check(typeof mod.registerModelViewRefresh === 'function', 'registerModelViewRefresh 已导出')

  // 无记录 → stale
  check(mod.isDiscoveryStale(1000, 100) === true, '无记录 → stale（需要刷新）')

  // 写入后：TTL 内不 stale，超 TTL stale
  mod.markDiscovered(1000)
  check(ls.store['aigd:lastDiscoveredAt'] === '1000', 'markDiscovered 写入时间戳')
  check(mod.isDiscoveryStale(1050, 100) === false, '距今 50ms < TTL 100 → 不 stale')
  check(mod.isDiscoveryStale(1100, 100) === false, '距今 100ms = TTL 边界 → 不 stale（> 才 stale）')
  check(mod.isDiscoveryStale(1101, 100) === true, '距今 101ms > TTL 100 → stale')

  // 非法记录 → stale
  ls.store['aigd:lastDiscoveredAt'] = 'not-a-number'
  check(mod.isDiscoveryStale(1000, 100) === true, '非法记录 → stale')
  ls.store['aigd:lastDiscoveredAt'] = '0'
  check(mod.isDiscoveryStale(1000, 100) === true, '零时间戳 → stale')
}

section('localStorage 不可用降级')
{
  delete globalThis.localStorage
  const mod = await import('../src/web/public/app.js')
  // 引用未声明的 localStorage 抛 ReferenceError，被 try/catch 兜底 → true
  check(mod.isDiscoveryStale(1000, 100) === true, 'localStorage 不可用 → stale（保守）')
  let threw = false
  try { mod.markDiscovered(1000) } catch { threw = true }
  check(!threw, 'markDiscovered 在 localStorage 不可用时静默不抛')
}

console.log(`\n${'='.repeat(56)}`)
console.log(`测试汇总: ${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
