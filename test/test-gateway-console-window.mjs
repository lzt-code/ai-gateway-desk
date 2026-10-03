/**
 * 跨平台终端弹窗测试 — src/gateway/console-window.js + process.js console 模式
 * （全 mock，不真实弹窗 / 不触网）
 * 覆盖：命令构造与转义 / 三平台 spawn 规格 / 终端探测（$TERMINAL·无头·回退链）/
 *       openInTerminal 成败 / startGatewayProcess 窗口模式（无退出竞速·超时·回落）
 */

import {
  LINUX_TERMINALS,
  buildGatewayCommand,
  buildSpawnSpec,
  detectTerminal,
  escapeAppleScript,
  openInTerminal,
  quotePosix,
  quoteWin,
} from '../src/gateway/console-window.js'
import { startGatewayProcess } from '../src/gateway/process.js'

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

function makeChild() {
  return {
    unrefed: 0,
    handlers: {},
    unref() {
      this.unrefed++
    },
    on(ev, fn) {
      this.handlers[ev] = fn
    },
    once(ev, fn) {
      this.handlers[ev] = fn
    },
  }
}

const GUI_ENV = { DISPLAY: ':0' }

section('1. 引号包裹与命令构造')
{
  check(quotePosix('/a b/node') === '"/a b/node"', 'POSIX 空格路径双引号包裹')
  check(quotePosix('/a"x$b/node') === '"/a\\"x\\$b/node"', 'POSIX 转义 " 与 $')
  check(quoteWin('C:\\Program Files\\node\\node.exe') === '"C:\\Program Files\\node\\node.exe"', 'Windows 空格路径包裹')

  const win = buildGatewayCommand({ execPath: 'C:\\n\\node.exe', binPath: 'C:\\p\\aigd.js', port: 8788, platform: 'win32' })
  check(
    win === '"C:\\n\\node.exe" "C:\\p\\aigd.js" gateway --port 8788',
    'win32 命令 = "<node>" "<bin>" gateway --port <port>'
  )
  const posix = buildGatewayCommand({ execPath: '/u/bin/node', binPath: '/p/aigd.js', port: 9000, platform: 'linux' })
  check(posix === '"/u/bin/node" "/p/aigd.js" gateway --port 9000', 'POSIX 命令同构')
}

section('2. AppleScript 转义')
{
  check(escapeAppleScript('a"b') === 'a\\"b', '双引号转义')
  check(escapeAppleScript('\\033]0;T\\007') === '\\\\033]0;T\\\\007', '反斜杠翻倍（ANSI 标题序列存活）')
  check(escapeAppleScript('\\"') === '\\\\\\"', '先反斜杠后引号（顺序正确）')
}

section('3. buildSpawnSpec：Windows')
{
  const spec = buildSpawnSpec({
    platform: 'win32',
    terminal: 'cmd-start',
    title: 'AI Gateway :8788',
    command: '"C:\\n\\node.exe" "C:\\p\\aigd.js" gateway --port 8788',
  })
  check(spec.command === 'cmd.exe', '经 cmd.exe 启动')
  check(spec.args[0] === '/c' && spec.args[1] === 'start' && spec.args[2] === '""', 'start 空标题占位')
  check(spec.args[3] === 'cmd' && spec.args[4] === '/k', 'cmd /k 保持窗口')
  check(
    spec.args[5] ===
      '"title AI Gateway :8788 && "C:\\n\\node.exe" "C:\\p\\aigd.js" gateway --port 8788 && exit"',
    '内层命令整体再包一层引号（cmd 剥离首尾引号后还原，避免 libuv 转义出 \\"）'
  )
  check(
    spec.args[5].startsWith('"title AI Gateway :8788 && ') && spec.args[5].endsWith('"'),
    '窗口内 title 命令设置标题（任务栏可见端口）'
  )
  check(spec.args[5].includes('gateway --port 8788'), '内层为网关启动命令')
  check(spec.args[5].includes('gateway --port 8788 && exit'), '正常退出后 && exit 关窗（异常退出短路，窗口保留看错误）')
  check(
    spec.options.detached === true &&
      spec.options.windowsHide === true &&
      spec.options.windowsVerbatimArguments === true,
    'detached + 隐藏启动器自身 + 禁止 libuv 二次转义'
  )
}

section('4. buildSpawnSpec：macOS')
{
  const spec = buildSpawnSpec({
    platform: 'darwin',
    terminal: 'terminal-app',
    title: 'AI Gateway :8788',
    command: '"/u/bin/node" "/p/aigd.js" gateway --port 8788',
  })
  check(spec.command === 'osascript', '经 osascript 调 Terminal.app')
  check(spec.args[1].includes('tell application "Terminal" to do script'), 'do script 打开新窗口')
  check(spec.args[1].includes('\\\\033]0;AI Gateway :8788\\\\007'), '标题经 ANSI 序列设置（AS 转义后）')
  check(spec.args[1].includes('\\"/u/bin/node\\"'), '命令内双引号已 AS 转义')
  check(spec.args[3].includes('to activate'), '激活 Terminal 到前台')
}

section('5. buildSpawnSpec：Linux 各终端')
{
  const cmd = '"/u/bin/node" "/p/aigd.js" gateway --port 8788'
  const gnome = buildSpawnSpec({ platform: 'linux', terminal: 'gnome-terminal', title: 'T', command: cmd })
  check(gnome.args[0] === '--title=T' && gnome.args[1] === '--', 'gnome-terminal：--title + -- 分隔')
  check(gnome.args[2] === 'bash' && gnome.args[3] === '-c', 'gnome-terminal：bash -c 数组式')
  check(
    gnome.args[4].includes('[ $ec -eq 0 ] || exec bash'),
    '命令结束后仅异常退出才 exec bash（正常退出关窗）'
  )

  const konsole = buildSpawnSpec({ platform: 'linux', terminal: 'konsole', title: 'T', command: cmd })
  check(konsole.args[0] === '-p' && konsole.args[1] === 'tabtitle=T', 'konsole：tabtitle')

  const xfce = buildSpawnSpec({ platform: 'linux', terminal: 'xfce4-terminal', title: 'T', command: cmd })
  check(xfce.args[1] === '--command', 'xfce4-terminal：--command 字符串式')
  check(xfce.args[2].startsWith('bash -c "') && xfce.args[2].includes('\\"/u/bin/node\\"'), '字符串式整体包裹且内层引号转义')

  const xterm = buildSpawnSpec({ platform: 'linux', terminal: 'xterm', title: 'T', command: cmd })
  check(xterm.args[0] === '-T' && xterm.args[1] === 'T', 'xterm：-T 标题')

  const unknown = buildSpawnSpec({ platform: 'linux', terminal: 'not-a-terminal', title: 'T', command: cmd })
  check(unknown === null, '未知终端 id → null')

  check(LINUX_TERMINALS[LINUX_TERMINALS.length - 1].id === 'xterm', 'xterm 兜底在候选表末尾')
}

section('6. detectTerminal')
{
  check(detectTerminal({ platform: 'win32' }) === 'cmd-start', 'Windows → cmd-start')
  check(detectTerminal({ platform: 'darwin' }) === 'terminal-app', 'macOS → terminal-app')

  check(
    detectTerminal({ platform: 'linux', env: {}, whichFn: () => true }) === null,
    'Linux 无 DISPLAY/WAYLAND_DISPLAY（无头）→ null'
  )

  const order = []
  const id = detectTerminal({
    platform: 'linux',
    env: GUI_ENV,
    whichFn: (n) => {
      order.push(n)
      return n === 'konsole'
    },
  })
  check(id === 'konsole', '按候选表顺序探测，命中 konsole')
  check(order[0] === 'gnome-terminal' && order[1] === 'konsole', '探测顺序 gnome → konsole')

  const custom = detectTerminal({
    platform: 'linux',
    env: { ...GUI_ENV, TERMINAL: '/usr/bin/alacritty' },
    whichFn: (n) => n === 'alacritty' || n === 'gnome-terminal',
  })
  check(custom === 'alacritty', '$TERMINAL 显式偏好优先于默认顺序')

  const none = detectTerminal({ platform: 'linux', env: GUI_ENV, whichFn: () => false })
  check(none === null, '有显示服务器但无任何终端 → null')
}

section('7. openInTerminal（mock spawn）')
{
  const child = makeChild()
  let captured = null
  const r = openInTerminal({
    title: 'AI Gateway :8788',
    execPath: 'C:\\n\\node.exe',
    binPath: 'C:\\p\\aigd.js',
    port: 8788,
    platform: 'win32',
    spawnFn: (cmd, args, opts) => {
      captured = { cmd, args, opts }
      return child
    },
  })
  check(r.ok === true && r.method === 'cmd-start', 'Windows 弹窗成功')
  check(captured.cmd === 'cmd.exe', 'spawn cmd.exe')
  check(captured.opts.windowsVerbatimArguments === true, '实际 spawn 走逐字参数（引号不被 libuv 转义）')
  check(child.unrefed === 1, '启动器 unref（不拖住父进程退出）')
  check(typeof child.handlers.error === 'function', '注册 error 静默兜底')

  const noTerm = openInTerminal({
    title: 'T',
    execPath: '/n',
    binPath: '/b',
    port: 1,
    platform: 'linux',
    env: {},
    whichFn: () => false,
  })
  check(noTerm.ok === false && noTerm.error.includes('桌面环境'), '无头 Linux → 明确错误')

  const boom = openInTerminal({
    title: 'T',
    execPath: 'C:\\n',
    binPath: 'C:\\b',
    port: 1,
    platform: 'win32',
    spawnFn: () => {
      throw new Error('spawn ENOENT')
    },
  })
  check(boom.ok === false && boom.error.includes('ENOENT'), 'spawn 抛错归类为弹窗失败')
}

section('8. startGatewayProcess：console 模式')
{
  // 窗口就绪：不做退出竞速（启动器立即返回），仅按 /health 探测
  let alive = 0
  let spawnCalled = false
  const ok = await startGatewayProcess({
    port: 8788,
    console: true,
    intervalMs: 5,
    timeoutMs: 1000,
    openInTerminalFn: () => ({ ok: true, method: 'cmd-start' }),
    spawnFn: () => {
      spawnCalled = true
      return makeChild()
    },
    isAlive: async () => {
      alive++
      return alive >= 2
    },
  })
  check(ok.ok === true && ok.console === 'cmd-start', '窗口模式启动成功，透出 console 机制')
  check(spawnCalled === false, '窗口模式不走隐藏 spawn')

  // 就绪超时：错误指向窗口输出
  const timeout = await startGatewayProcess({
    port: 8788,
    console: true,
    intervalMs: 10,
    timeoutMs: 60,
    openInTerminalFn: () => ({ ok: true, method: 'terminal-app' }),
    isAlive: async () => false,
  })
  check(timeout.ok === false && timeout.error.includes('控制台窗口'), '超时错误提示查看窗口输出')

  // 弹窗失败 → 回落隐藏式后台启动
  let fallbackSpawn = false
  let alive2 = 0
  const fb = await startGatewayProcess({
    port: 8788,
    console: true,
    intervalMs: 5,
    timeoutMs: 1000,
    openInTerminalFn: () => ({ ok: false, error: 'no terminal' }),
    spawnFn: () => {
      fallbackSpawn = true
      return makeChild()
    },
    isAlive: async () => {
      alive2++
      return alive2 >= 2
    },
  })
  check(fb.ok === true && fallbackSpawn === true && !fb.console, '弹窗失败回落隐藏启动（无 console 字段）')

  // 弹窗实现抛异常 → 同样回落
  let fallbackSpawn2 = false
  const fb2 = await startGatewayProcess({
    port: 8788,
    console: true,
    intervalMs: 5,
    timeoutMs: 1000,
    openInTerminalFn: () => {
      throw new Error('unexpected')
    },
    spawnFn: () => {
      fallbackSpawn2 = true
      return makeChild()
    },
    isAlive: async () => true,
  })
  check(fb2.ok === true && fallbackSpawn2 === true, '弹窗异常同样回落隐藏启动')

  // 未开 console → 原行为不变
  const plain = await startGatewayProcess({
    port: 8788,
    intervalMs: 5,
    timeoutMs: 1000,
    spawnFn: () => makeChild(),
    isAlive: async () => true,
  })
  check(plain.ok === true && typeof plain.console === 'undefined', '默认（无 console）行为不变')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)
