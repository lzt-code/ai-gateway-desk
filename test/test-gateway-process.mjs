/**
 * 本地网关进程编排测试 — src/gateway/process.js（全 mock，不真实 spawn / 不触网）
 * 覆盖：argv 构造 / waitFor / readLogTail / detached spawn 参数 /
 *       启动就绪 · 立即退出 · 就绪超时 / 关闭（成功 · 403 · 异常 · 超时）
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildGatewayChildArgs,
  readLogTail,
  spawnGatewayChild,
  startGatewayProcess,
  stopGatewayProcess,
  waitFor,
} from '../src/gateway/process.js'

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

// mock child：记录 once/unref 调用，可手动触发 exit
function makeChild() {
  const c = {
    handlers: {},
    unrefed: 0,
    once(ev, fn) {
      c.handlers[ev] = fn
    },
    unref() {
      c.unrefed++
    },
  }
  return c
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aigd-gw-process-'))

try {
  section('1. buildGatewayChildArgs')
  {
    check(
      JSON.stringify(buildGatewayChildArgs('/x/aigd.js', 8788)) ===
        JSON.stringify(['/x/aigd.js', 'gateway', '--port', '8788']),
      'argv = [bin, gateway, --port, <port>]'
    )
  }

  section('2. waitFor')
  {
    let n = 0
    const ok = await waitFor(
      () => {
        n++
        return n >= 3
      },
      { timeoutMs: 1000, intervalMs: 5 }
    )
    check(ok === true && n === 3, '条件成立即返回 true（轮询 3 次）')

    const timedOut = await waitFor(() => false, { timeoutMs: 40, intervalMs: 5 })
    check(timedOut === false, '超时返回 false')

    const throwing = await waitFor(() => {
      throw new Error('boom')
    }, { timeoutMs: 30, intervalMs: 5 })
    check(throwing === false, 'check 抛错视为未成立（不向外抛）')

    let calls = 0
    const truthy = await waitFor(async () => {
      calls++
      return 'yes'
    }, { timeoutMs: 1000, intervalMs: 5 })
    check(truthy === false && calls >= 1, '非 true 的返回值不算成立')
  }

  section('3. readLogTail')
  {
    check(readLogTail(path.join(tmp, '缺省.log')) === '', '文件不存在 → 空串')

    const long = path.join(tmp, 'long.log')
    writeFileSync(long, `${'a'.repeat(2000)}尾`)
    const tail = readLogTail(long, 50)
    check(tail.length === 50 && tail.endsWith('尾'), '超长时截取尾部 maxChars 字符')

    const padded = path.join(tmp, 'pad.log')
    writeFileSync(padded, '  hello  \n')
    check(readLogTail(padded) === 'hello', '去除首尾空白')
  }

  section('4. spawnGatewayChild：detached + unref + 日志重定向')
  {
    const logPath = path.join(tmp, 'spawn.log')
    const child = makeChild()
    let captured = null
    spawnGatewayChild({
      port: 8788,
      logPath,
      spawnFn: (cmd, args, opts) => {
        captured = { cmd, args, opts }
        return child
      },
    })
    check(captured.args[1] === 'gateway' && captured.args[3] === '8788', '参数含 gateway 子命令与端口')
    check(captured.opts.detached === true, 'detached=true（新进程组）')
    check(captured.opts.windowsHide === true, 'windowsHide=true（不弹控制台窗口）')
    check(
      Array.isArray(captured.opts.stdio) &&
        captured.opts.stdio[0] === 'ignore' &&
        typeof captured.opts.stdio[1] === 'number' &&
        captured.opts.stdio[1] === captured.opts.stdio[2],
      'stdout/stderr 重定向到日志 fd，stdin 忽略'
    )
    check(child.unrefed === 1, 'unref 调用一次')

    const child2 = makeChild()
    let captured2 = null
    spawnGatewayChild({
      port: 8788,
      logPath: path.join(tmp, 'no-such-dir', 'x.log'),
      spawnFn: (cmd, args, opts) => {
        captured2 = { opts }
        return child2
      },
    })
    check(captured2.opts.stdio === 'ignore', '日志不可写 → stdio 退化为 ignore')
  }

  section('5. startGatewayProcess：就绪')
  {
    const logPath = path.join(tmp, 'ready.log')
    const child = makeChild()
    let alive = 0
    const r = await startGatewayProcess({
      port: 8788,
      logPath,
      intervalMs: 5,
      timeoutMs: 1000,
      spawnFn: () => child,
      isAlive: async () => {
        alive++
        return alive >= 2
      },
    })
    check(r.ok === true && r.running === true && r.port === 8788, 'ok/running/port 正确')
    check(typeof r.error === 'undefined', '成功时不带 error')
  }

  section('6. startGatewayProcess：子进程立即退出（回读日志尾部）')
  {
    const logPath = path.join(tmp, 'eaddr.log')
    const child = makeChild()
    const p = startGatewayProcess({
      port: 8788,
      logPath,
      intervalMs: 5,
      timeoutMs: 3000,
      spawnFn: () => {
        writeFileSync(logPath, '[aigd] 网关启动失败: 端口 8788 已被占用')
        return child
      },
      isAlive: async () => false,
    })
    setTimeout(() => child.handlers.exit?.(1), 10)
    const r = await p
    check(r.ok === false && r.running === false, '报告失败')
    check(r.error.includes('立即退出'), '错误说明进程退出')
    check(r.error.includes('已被占用'), '错误含日志尾部（端口占用原因）')
  }

  section('7. startGatewayProcess：就绪超时')
  {
    const child = makeChild()
    const r = await startGatewayProcess({
      port: 8788,
      logPath: path.join(tmp, 'timeout.log'),
      intervalMs: 10,
      timeoutMs: 80,
      spawnFn: () => child,
      isAlive: async () => false,
    })
    check(r.ok === false && r.error.includes('超时'), '超时报错')
  }

  section('8. startGatewayProcess：spawn 抛错')
  {
    const r = await startGatewayProcess({
      port: 8788,
      logPath: path.join(tmp, 'spawn-fail.log'),
      spawnFn: () => {
        throw new Error('ENOENT node')
      },
      isAlive: async () => false,
    })
    check(r.ok === false && r.error.includes('无法启动网关进程'), '透出 spawn 异常')
  }

  section('9. stopGatewayProcess：关闭成功')
  {
    const calls = []
    let probeCount = 0
    const r = await stopGatewayProcess({
      port: 8788,
      intervalMs: 5,
      timeoutMs: 500,
      fetchFn: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200 }
      },
      isAlive: async () => {
        probeCount++
        return probeCount < 2 // 第一次仍存活，之后视为已退出
      },
    })
    check(calls[0].url === 'http://127.0.0.1:8788/api/gateway/shutdown', '请求网关 shutdown 端点')
    check(calls[0].init.method === 'POST', 'POST 方式')
    check(r.ok === true && r.running === false, '关闭成功')
  }

  section('10. stopGatewayProcess：非 2xx / 网络异常 / 关闭超时')
  {
    const denied = await stopGatewayProcess({
      port: 8788,
      fetchFn: async () => ({ ok: false, status: 403 }),
      isAlive: async () => true,
    })
    check(denied.ok === false && denied.running === true && denied.error.includes('403'), '403 透出状态码')

    const broken = await stopGatewayProcess({
      port: 8788,
      fetchFn: async () => {
        throw new TypeError('fetch failed')
      },
      isAlive: async () => true,
    })
    check(broken.ok === false && broken.error.includes('发送关闭请求失败'), '网络异常归类')

    const stuck = await stopGatewayProcess({
      port: 8788,
      fetchFn: async () => ({ ok: true, status: 200 }),
      intervalMs: 5,
      timeoutMs: 40,
      isAlive: async () => true,
    })
    check(stuck.ok === false && stuck.running === true && stuck.error.includes('超时'), '仍存活 → 关闭超时')

    const probeThrows = await stopGatewayProcess({
      port: 8788,
      fetchFn: async () => ({ ok: true, status: 200 }),
      intervalMs: 5,
      timeoutMs: 200,
      isAlive: async () => {
        throw new TypeError('ECONNREFUSED')
      },
    })
    check(probeThrows.ok === true, '探测异常（连接被拒）视为已关闭')
  }

  section('11. 日志文件确实被创建（真实 fd 路径）')
  {
    const logPath = path.join(tmp, 'real-fd.log')
    spawnGatewayChild({
      port: 8788,
      logPath,
      spawnFn: () => makeChild(),
    })
    check(readFileSync(logPath, 'utf8') === '', 'spawn 前打开日志文件（截断为本次运行）')
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
