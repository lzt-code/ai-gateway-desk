/**
 * 任务 25 验证脚本：Web 服务器基础（Hono + 静态文件服务 + 启动器）
 *
 * 覆盖：createApp 静态文件/健康检查/默认 publicDir、buildOpenCommand 三平台、
 * openBrowser（mock spawnFn / 失败静默）、startServer 集成（随机端口/真实请求/
 * 端口释放/自动开浏览器）、CLI 冒烟（web 子命令/默认子命令/help）、package.json 依赖。
 * 不触网（无外网请求）；可短暂监听本地随机端口；任一失败打印清晰信息 + exit 1。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createApp, buildOpenCommand, openBrowser, startServer } from '../src/web/server.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const binPath = path.join(root, 'src', 'bin', 'aigd.js')

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

// 临时目录 fixture：mkdtempSync + 写入 index.html
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigw-test-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>')
  return dir
}

// 路径穿越 URL（测试 4）：按平台分支构造（期望一律 404，serveStatic 自带防护）
const TRAVERSAL_URL = process.platform === 'win32'
  ? '/' + '..%2f'.repeat(5) + 'Windows/win.ini'
  : '/' + '..%2f'.repeat(6) + 'etc/hostname'

// ── 测试 1-4：createApp 静态文件（临时目录 fixture）──
section('测试 1-4: 静态文件服务（临时目录）')
{
  const dir = makeFixture()
  const app = createApp({ publicDir: dir })

  // 1：根路径 → index.html
  const resRoot = await app.request('/')
  check(resRoot.status === 200, '根路径返回 200')
  check((await resRoot.text()).includes('<h1>hello</h1>'), '根路径返回 index.html 内容')

  // 2：显式文件名
  const resFile = await app.request('/index.html')
  check(resFile.status === 200, '/index.html 返回 200')
  check((resFile.headers.get('content-type') || '').includes('text/html'), 'content-type 含 text/html')
  check((await resFile.text()).includes('<h1>hello</h1>'), '/index.html 内容正确')

  // 2b：静态资源不缓存（前端零构建无指纹，启发式缓存会导致更新后浏览器复用旧版
  // app.js/index.html —— Provider 视图「无刷新按钮」即此症状；no-cache 强制每次校验）
  const resCache = await app.request('/index.html')
  check((resCache.headers.get('cache-control') || '').includes('no-cache'),
    '静态文件响应含 Cache-Control: no-cache（实际=' + (resCache.headers.get('cache-control') || '(无)') + '）')
  // 3：不存在的文件
  const resMissing = await app.request('/missing.txt')
  check(resMissing.status === 404, '不存在的文件返回 404')

  // 4：路径穿越防护（root 外不泄露）
  const resTraversal = await app.request(TRAVERSAL_URL)
  check(resTraversal.status === 404, `路径穿越返回 404（URL=${TRAVERSAL_URL.slice(0, 40)}…）`)

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 测试 5-6：健康检查 + 默认 publicDir ──
section('测试 5-6: 健康检查 + 默认 publicDir')
{
  const app = createApp({ publicDir: makeFixture() })
  const resHealth = await app.request('/api/health')
  check(resHealth.status === 200, '/api/health 返回 200')
  check((await resHealth.json()).ok === true, '健康检查 JSON ok === true')

  // 6：不传 publicDir → 真实占位页存在
  const appDefault = createApp()
  const resDefault = await appDefault.request('/')
  check(resDefault.status === 200, '默认 publicDir 根路径 200')
  check((await resDefault.text()).includes('ai-gateway-desk'), '默认 publicDir 含真实占位页内容')
}

// ── 测试 7-9：buildOpenCommand 三平台 ──
section('测试 7-9: buildOpenCommand 三平台')
{
  const u = 'http://127.0.0.1:45678'
  const win = buildOpenCommand('win32', u)
  check(JSON.stringify(win) === JSON.stringify(['cmd', '/c', 'start', '', u]),
    `win32 → ['cmd','/c','start','',url]（实际=${JSON.stringify(win)}）`)
  const dar = buildOpenCommand('darwin', u)
  check(JSON.stringify(dar) === JSON.stringify(['open', u]), 'darwin → [open, url]')
  const lin = buildOpenCommand('linux', u)
  check(JSON.stringify(lin) === JSON.stringify(['xdg-open', u]), '其他平台 → [xdg-open, url]')
}

// ── 测试 10-11：openBrowser（mock spawnFn）──
section('测试 10-11: openBrowser（mock spawnFn）')
{
  // 10：win32 平台命令参数正确
  let captured = null
  const mockSpawn = (...args) => {
    captured = args
    return { on: () => {} }
  }
  const u = 'http://127.0.0.1:45678'
  openBrowser(u, { platform: 'win32', spawnFn: mockSpawn })
  check(captured !== null, 'spawnFn 被调用')
  check(
    JSON.stringify(captured) === JSON.stringify(['cmd', ['/c', 'start', '', u], { stdio: 'ignore' }]),
    `mock 收到正确命令（实际=${JSON.stringify(captured)}）`
  )

  // 11：spawn 失败（如 xdg-open 缺失）不抛异常
  let threw = false
  try {
    openBrowser(u, { platform: 'linux', spawnFn: () => ({ on: () => {} }) })
  } catch {
    threw = true
  }
  check(!threw, 'spawn error 事件静默（不抛异常）')
}

// ── 测试 12-15：startServer 集成 ──
section('测试 12-15: startServer 集成')
{
  // 12：随机端口 + URL 形式
  const first = await startServer({ port: 0, openBrowser: false, installSignalHandlers: false })
  check(Number.isInteger(first.port) && first.port > 0, `随机端口有效（port=${first.port}）`)
  check(first.url.startsWith('http://127.0.0.1:'), `URL 形式正确（实际 ${first.url}）`)

  // 13：真实请求（健康检查 + 根路径占位页）
  const health = await (await fetch(first.url + '/api/health')).json()
  check(health.ok === true, '真实请求健康检查 ok')
  const rootRes = await fetch(first.url + '/')
  check(rootRes.status === 200, '真实请求根路径 200')
  check((await rootRes.text()).includes('ai-gateway-desk'), '真实请求根路径含占位页内容')

  // 14：close 释放端口（同一 port 可再次绑定）
  await first.close()
  const again = await startServer({ port: first.port, openBrowser: false, installSignalHandlers: false })
  check(again.port === first.port, 'close 后端口可复用')
  await again.close()

  // 15：自动开浏览器（openFn mock 被调用）
  let openedUrl = null
  const withOpen = await startServer({
    port: 0,
    openBrowser: true,
    openFn: (u) => { openedUrl = u },
    installSignalHandlers: false,
  })
  check(openedUrl !== null && openedUrl.startsWith('http://127.0.0.1:'),
    `自动开浏览器调用了 openFn（实际=${openedUrl}）`)
  await withOpen.close()
}

// ── 测试 15b-15e：心跳自动退出（桌面应用式关闭语义）──
// 网页是 UI 唯一入口：收到过心跳后超时无心跳（或 goodbye 后宽限无新心跳）
// 视为页面全部关闭 → 自动退出。exitFn mock 捕获退出路径（不真杀测试进程）。
section('测试 15b-15e: 心跳自动退出')
{
  // 15b：createApp + heartbeatState 注入：心跳更新 / goodbye 标记 / 新心跳取消
  const hb = { lastHeartbeat: null, goodbyeAt: null }
  const app = createApp({ publicDir: makeFixture(), heartbeatState: hb })
  const res = await app.request('/api/heartbeat', { method: 'POST' })
  check(res.status === 200 && (await res.json()).ok === true, 'POST /api/heartbeat 返回 ok')
  check(typeof hb.lastHeartbeat === 'number' && hb.goodbyeAt === null,
    '心跳更新 lastHeartbeat 且初始无 goodbyeAt')
  await app.request('/api/heartbeat?goodbye=1', { method: 'POST' })
  check(typeof hb.goodbyeAt === 'number', '?goodbye=1 记录 goodbyeAt（加速退出信号）')
  await app.request('/api/heartbeat', { method: 'POST' })
  check(hb.goodbyeAt === null, '新心跳清除 goodbyeAt（刷新场景取消退出）')

  // 15c：收到过心跳后超时无心跳 → 自动退出（exitFn 被调用一次）
  let exitCalled = 0
  const hs = await startServer({
    port: 0,
    openBrowser: false,
    installSignalHandlers: false,
    heartbeatTimeout: 200,
    heartbeatCheckInterval: 40,
    exitFn: () => { exitCalled++ },
  })
  await fetch(hs.url + '/api/heartbeat', { method: 'POST' })
  await new Promise((r) => setTimeout(r, 500))
  check(exitCalled === 1, `心跳超时后自动退出（exitFn 调用 ${exitCalled} 次）`)
  await hs.close()

  // 15d：从未收到心跳不自动退出（curl / 未打开页面场景）
  let exitCalled2 = 0
  const hs2 = await startServer({
    port: 0,
    openBrowser: false,
    installSignalHandlers: false,
    heartbeatTimeout: 200,
    heartbeatCheckInterval: 40,
    exitFn: () => { exitCalled2++ },
  })
  await new Promise((r) => setTimeout(r, 500))
  check(exitCalled2 === 0, '从未收到心跳不自动退出')
  await hs2.close()

  // 15e：goodbye 后宽限内新心跳取消退出（刷新页面不误杀）
  let exitCalled3 = 0
  const hs3 = await startServer({
    port: 0,
    openBrowser: false,
    installSignalHandlers: false,
    heartbeatTimeout: 1500,
    heartbeatCheckInterval: 40,
    exitFn: () => { exitCalled3++ },
  })
  await fetch(hs3.url + '/api/heartbeat?goodbye=1', { method: 'POST' })
  await new Promise((r) => setTimeout(r, 150)) // 模拟刷新：goodbye 后新页面加载
  await fetch(hs3.url + '/api/heartbeat', { method: 'POST' })
  await new Promise((r) => setTimeout(r, 600))
  check(exitCalled3 === 0, 'goodbye 后新心跳取消退出（刷新场景）')
  await hs3.close()
}

// ── 测试 16-17：CLI 冒烟（spawn + stdout 检测 + 超时兜底）──
async function cliSmoke(args) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: { ...process.env, AIGD_NO_OPEN: '1' },
  })
  let out = ''
  let err = ''
  let timer
  await new Promise((resolve) => {
    timer = setTimeout(() => { child.kill(); resolve() }, 8000)
    child.stdout.on('data', (d) => {
      out += d
      if (out.includes('127.0.0.1')) {
        clearTimeout(timer)
        child.kill()
        resolve()
      }
    })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', () => { clearTimeout(timer); resolve() })
  })
  return { out, err }
}

section('测试 16-17: CLI 冒烟')
{
  // 16：web 子命令
  const web = await cliSmoke(['web'])
  check(web.out.includes('127.0.0.1'), `web 子命令启动并打印 URL（out=${JSON.stringify(web.out.slice(0, 80))}）`)
  check(!/Error|at /.test(web.err), `web 子命令 stderr 无异常堆栈（实际=${JSON.stringify(web.err.slice(0, 120))}）`)

  // 17：默认子命令 = web
  const def = await cliSmoke([])
  check(def.out.includes('127.0.0.1'), `默认子命令启动并打印 URL（out=${JSON.stringify(def.out.slice(0, 80))}）`)
  check(!/Error|at /.test(def.err), `默认子命令 stderr 无异常堆栈（实际=${JSON.stringify(def.err.slice(0, 120))}）`)
}

// ── 测试 18：CLI help 含 web ──
section('测试 18: CLI help')
{
  const res = spawnSync(process.execPath, [binPath, 'help'], { encoding: 'utf8' })
  check(res.status === 0, `help 退出码 0（status=${res.status}）`)
  check(res.stdout.includes('web') && res.stdout.includes('用法'), 'help 输出含 web 与 用法')
}

// ── 测试 19-21：package.json 依赖 ──
section('测试 19-21: package.json 依赖')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const deps = pkg.dependencies || {}
  check(typeof deps['hono'] === 'string', `依赖含 hono（实际=${JSON.stringify(deps['hono'])}）`)
  check(typeof deps['@hono/node-server'] === 'string', `依赖含 @hono/node-server（实际=${JSON.stringify(deps['@hono/node-server'])}）`)
  check(!deps['neo-blessed'], 'neo-blessed 已移除（任务 34）')
  const ver = String(deps['@hono/node-server'])
  const major = parseInt((ver.match(/\d+/) || ['NaN'])[0], 10)
  check(major === 1, `@hono/node-server 主版本号 === 1（防误升 2.x 破坏 Node 18，实际=${ver}）`)
  check(typeof pkg.scripts.web === 'string' && pkg.scripts.web.length > 0,
    `scripts.web 存在（实际=${JSON.stringify(pkg.scripts.web)}）`)
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
