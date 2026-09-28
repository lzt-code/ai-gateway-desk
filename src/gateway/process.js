// ============================================================
// 本地网关进程编排 — 管理界面（独立进程）启动 / 关闭本地网关
// ============================================================
// 管理界面与本地网关是两个进程，二者唯一耦合是 data/gateway.json 的端口：
//   · 启动：管理界面以 detached + unref spawn `aigd gateway --port <port>`
//     （新进程组），网关脱离管理界面独立存活——终端 Ctrl+C 或关闭 / 重启
//     管理界面都不影响它；
//   · 关闭：向网关 `POST /api/gateway/shutdown` 发请求，由网关进程自行优雅退出
//     （不做 PID 文件管理，避免 PID 复用误杀）；
//   · 探测：`GET /health`（见 src/web/server.js probeGateway）。
// 故管理界面重启后，按 gateway.json 的端口探测即可恢复网关运行状态。
//
// 子进程 stdout/stderr 重定向到 data/gateway.log（每次启动重置），启动失败时
// 回读日志尾部作为错误详情；日志内容由网关进程自身的统一日志器写入。
// 本模块只做进程编排，IO 结果由调用方（web/server.js 的 /api/gateway/* 端点）
// 走统一日志器记录。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/** CLI 入口（子进程执行 `node <bin> gateway --port <port>`） */
export const DEFAULT_GATEWAY_BIN = path.resolve(PROJECT_ROOT, 'src', 'bin', 'aigd.js')

/** 网关子进程输出日志（data/* 已在 .gitignore 中排除） */
export const DEFAULT_GATEWAY_LOG = path.resolve(PROJECT_ROOT, 'data', 'gateway.log')

export const DEFAULT_START_TIMEOUT_MS = 12000
export const DEFAULT_STOP_TIMEOUT_MS = 6000
export const DEFAULT_POLL_INTERVAL_MS = 250

/**
 * 构造网关子进程 argv（不含 node 可执行文件本身）
 * @param {string} binPath
 * @param {number} port
 * @returns {string[]}
 */
export function buildGatewayChildArgs(binPath, port) {
  return [binPath, 'gateway', '--port', String(port)]
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询等待条件成立（check 抛错视为未成立）
 * @param {() => (boolean|Promise<boolean>)} check
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<boolean>} 超时返回 false
 */
export async function waitFor(
  check,
  { timeoutMs = DEFAULT_START_TIMEOUT_MS, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let ok = false
    try {
      ok = (await check()) === true
    } catch {
      ok = false
    }
    if (ok) return true
    const remain = deadline - Date.now()
    if (remain <= 0) return false
    await sleep(Math.min(intervalMs, remain))
  }
}

/**
 * 读取日志尾部（启动失败详情用）
 * @param {string} filePath
 * @param {number} [maxChars]
 * @returns {string} 文件不存在 / 读取失败 → ''
 */
export function readLogTail(filePath, maxChars = 1200) {
  try {
    const text = fs.readFileSync(filePath, 'utf8').trim()
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

/**
 * 以脱离父进程的方式启动网关子进程
 * @param {object} options
 * @param {number} options.port
 * @param {Function} [options.spawnFn] - child_process.spawn（测试注入）
 * @param {string} [options.execPath] - node 可执行文件（默认当前进程）
 * @param {string} [options.binPath]
 * @param {string} [options.logPath]
 * @returns {object} child（已 unref）
 */
export function spawnGatewayChild({
  port,
  spawnFn = spawn,
  execPath = process.execPath,
  binPath = DEFAULT_GATEWAY_BIN,
  logPath = DEFAULT_GATEWAY_LOG,
}) {
  let logFd = null
  try {
    logFd = fs.openSync(logPath, 'w') // 每次启动重置，日志不无限增长
  } catch {
    logFd = null // data/ 不可写 → 丢弃子进程输出（启动结果仍以 /health 为准）
  }
  let child
  try {
    child = spawnFn(execPath, buildGatewayChildArgs(binPath, port), {
      detached: true, // 新进程组：脱离管理界面与终端信号
      windowsHide: true, // Windows：不弹控制台窗口
      stdio: logFd == null ? 'ignore' : ['ignore', logFd, logFd],
    })
  } finally {
    if (logFd != null) {
      try {
        fs.closeSync(logFd)
      } catch {
        // 关闭父进程副本失败不影响子进程持有的句柄
      }
    }
  }
  if (typeof child.unref === 'function') child.unref()
  return child
}

/**
 * 启动网关并等待其就绪（探测 /health）
 * @param {object} options
 * @param {number} options.port
 * @param {() => (boolean|Promise<boolean>)} options.isAlive - 端口上有本网关存活
 * @param {Function} [options.spawnFn]
 * @param {string} [options.execPath]
 * @param {string} [options.binPath]
 * @param {string} [options.logPath]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<{ ok: boolean, running: boolean, port: number, error?: string }>}
 */
export async function startGatewayProcess({
  port,
  isAlive,
  spawnFn = spawn,
  execPath = process.execPath,
  binPath = DEFAULT_GATEWAY_BIN,
  logPath = DEFAULT_GATEWAY_LOG,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const probe = typeof isAlive === 'function' ? isAlive : async () => false

  let child
  try {
    child = spawnGatewayChild({ port, spawnFn, execPath, binPath, logPath })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, running: false, port, error: `无法启动网关进程：${message}` }
  }

  // 启动失败（如端口被占用）时子进程会立即退出：与就绪探测竞速，避免白等超时
  const exited = new Promise((resolve) => {
    if (typeof child.once === 'function') child.once('exit', () => resolve('exit'))
  })
  const ready = waitFor(probe, { timeoutMs, intervalMs }).then((ok) => (ok ? 'ready' : 'timeout'))
  const outcome = await Promise.race([ready, exited])

  if (outcome === 'ready') return { ok: true, running: true, port }

  // 子进程已退出但端口上已有网关在服务（如另一个实例先就绪）：以实际探测为准
  if (outcome === 'exit' && (await waitFor(probe, { timeoutMs: 500, intervalMs: 100 }))) {
    return { ok: true, running: true, port }
  }

  const logTail = readLogTail(logPath)
  const reason =
    outcome === 'exit' ? '网关进程启动后立即退出' : `等待网关就绪超时（${timeoutMs}ms）`
  return {
    ok: false,
    running: false,
    port,
    error: logTail ? `${reason}：${logTail}` : reason,
  }
}

/**
 * 关闭网关：请求其优雅退出，并等待端口不再响应
 * @param {object} options
 * @param {number} options.port
 * @param {() => (boolean|Promise<boolean>)} options.isAlive
 * @param {Function} [options.fetchFn]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @returns {Promise<{ ok: boolean, running: boolean, port: number, error?: string }>}
 */
export async function stopGatewayProcess({
  port,
  isAlive,
  fetchFn = fetch,
  timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  const probe = typeof isAlive === 'function' ? isAlive : async () => false

  let res
  try {
    res = await fetchFn(`http://127.0.0.1:${port}/api/gateway/shutdown`, { method: 'POST' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, running: true, port, error: `发送关闭请求失败：${message}` }
  }
  if (!res.ok) {
    return { ok: false, running: true, port, error: `网关拒绝关闭请求（HTTP ${res.status}）` }
  }

  // 探测抛错（连接被拒）视为已关闭，避免因探测异常白等超时
  const stopped = await waitFor(
    async () => {
      try {
        return !(await probe())
      } catch {
        return true
      }
    },
    { timeoutMs, intervalMs }
  )
  if (stopped) return { ok: true, running: false, port }
  return { ok: false, running: true, port, error: `关闭超时（${timeoutMs}ms）：网关仍在运行` }
}
