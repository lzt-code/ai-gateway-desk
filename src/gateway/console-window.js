// ============================================================
// 跨平台终端弹窗 — 在可见命令行窗口中启动本地网关
// ============================================================
// 目标：网关启动后用户能直观看到"它在跑"（窗口在 = 网关在），并实时看到
// 统一日志器写入 stdout 的运行日志（io-logger 本就 console.log，零改动获得）。
//
// 窗口生命周期：网关**正常退出**（UI「关闭网关」→ /shutdown → process.exit(0)，
// 或窗口内 Ctrl+C）时自动关闭窗口；**异常退出**（启动失败 / 崩溃，退出码非 0）
// 时窗口保留，供用户查看错误输出。各平台实现：
//   · Windows  命令尾追加 `&& exit`：cmd 仅在网关退出码为 0 时执行 exit 关窗
//   · Linux    命令尾 `; ec=$?; [ $ec -eq 0 ] || exec bash`：成功则不挂住窗口，
//              失败才 exec bash 保持窗口
//   · macOS    do script 由 Terminal.app 按「shell 干净退出则关窗」处理
//
// 平台机制：
//   · Windows  cmd /c start "" cmd /k ""title <标题> && <命令> && exit""（窗口标题进任务栏）
//              —— 内层命令必须整体再包一层引号，并配 windowsVerbatimArguments，
//                 否则 Node/libuv 会按 CRT 规则把内层引号转义为 \"…\"，而 cmd 不认
//                 \ 转义，会报「'\"C:\…\node.exe\"' 不是内部或外部命令」。
//   · macOS    osascript 调 Terminal.app do script（title 经 ANSI 转义设置）
//   · Linux    按优先级探测可用终端模拟器（$TERMINAL → DE 原生 → 通用 → xterm），
//              无桌面环境（无 DISPLAY/WAYLAND_DISPLAY）直接判定不可用
//
// 降级：调用方（process.js）在弹窗失败时回落隐藏式后台启动，网关可用性不依赖
// 本模块。构建/探测为纯函数（spawnFn/whichFn/env 可注入），spawn 结果走统一
// 日志器（操作名 gateway:window）。
// ============================================================

import { spawn, spawnSync } from 'node:child_process'

import { logResult } from '../core/io-logger.js'

/** POSIX shell 双引号包裹（转义 " \ $ `） */
export function quotePosix(s) {
  return `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`
}

/** Windows cmd 双引号包裹（剥离已有引号；本工具自产路径可控） */
export function quoteWin(s) {
  return `"${String(s).replace(/"/g, '')}"`
}

/**
 * 构造网关启动命令行（单条 shell 命令字符串）
 * @param {{ execPath: string, binPath: string, port: number, platform: string }} opts
 * @returns {string}
 */
export function buildGatewayCommand({ execPath, binPath, port, platform }) {
  const q = platform === 'win32' ? quoteWin : quotePosix
  return `${q(execPath)} ${q(binPath)} gateway --port ${port}`
}

/** AppleScript 字符串字面量转义（先反斜杠后引号） */
export function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * POSIX 壳命令后缀 — 网关正常退出（code 0）不挂住窗口，异常退出则 exec bash
 * 保留窗口以查看错误输出（与 Windows 的 `&& exit` 语义对齐）。
 */
export const POSIX_HOLD_ON_FAILURE = '; ec=$?; [ $ec -eq 0 ] || exec bash'

/**
 * Linux 终端模拟器候选表（探测顺序即优先级）
 * build(title, command) → spawn args；command 为单条 shell 命令字符串。
 * 字符串型参数（xfce4/mate/lxterminal 的 -e/--command）需整体再包一层引号。
 */
export const LINUX_TERMINALS = [
  {
    id: 'gnome-terminal',
    probe: 'gnome-terminal',
    build: (t, c) => [`--title=${t}`, '--', 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
  {
    id: 'konsole',
    probe: 'konsole',
    build: (t, c) => ['-p', `tabtitle=${t}`, '-e', 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
  {
    id: 'xfce4-terminal',
    probe: 'xfce4-terminal',
    build: (t, c) => [`--title=${t}`, '--command', `bash -c ${quotePosix(`${c}${POSIX_HOLD_ON_FAILURE}`)}`],
  },
  {
    id: 'mate-terminal',
    probe: 'mate-terminal',
    build: (t, c) => [`--title=${t}`, '-e', `bash -c ${quotePosix(`${c}${POSIX_HOLD_ON_FAILURE}`)}`],
  },
  {
    id: 'lxterminal',
    probe: 'lxterminal',
    build: (t, c) => [`--title=${t}`, '-e', `bash -c ${quotePosix(`${c}${POSIX_HOLD_ON_FAILURE}`)}`],
  },
  {
    id: 'alacritty',
    probe: 'alacritty',
    build: (t, c) => ['--title', t, '-e', 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
  {
    id: 'kitty',
    probe: 'kitty',
    build: (t, c) => ['--title', t, 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
  {
    id: 'x-terminal-emulator',
    probe: 'x-terminal-emulator',
    build: (t, c) => ['-e', 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
  {
    id: 'xterm',
    probe: 'xterm',
    build: (t, c) => ['-T', t, '-e', 'bash', '-c', `${c}${POSIX_HOLD_ON_FAILURE}`],
  },
]

/** 默认 which 探测（仅 Linux 路径用到） */
function defaultWhich(name) {
  try {
    return spawnSync('which', [name], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * 探测当前平台可用的终端机制
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {object} [options.env] - 环境变量（默认 process.env）
 * @param {Function} [options.whichFn] - (name) => boolean（测试注入）
 * @returns {string|null} 'cmd-start' | 'terminal-app' | LINUX_TERMINALS 的 id | null
 */
export function detectTerminal({
  platform = process.platform,
  env = process.env,
  whichFn = defaultWhich,
} = {}) {
  if (platform === 'win32') return 'cmd-start'
  if (platform === 'darwin') return 'terminal-app'
  // Linux 及其他：无显示服务器 → 必然弹不出窗口
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null
  // $TERMINAL 优先（用户显式偏好），仅当能映射到已知参数约定时采纳
  if (env.TERMINAL) {
    const base = String(env.TERMINAL).split('/').pop()
    const hit = LINUX_TERMINALS.find((t) => t.probe === base)
    if (hit && whichFn(hit.probe)) return hit.id
  }
  for (const t of LINUX_TERMINALS) {
    if (whichFn(t.probe)) return t.id
  }
  return null
}

/**
 * 构造弹窗 spawn 规格（纯函数）
 * @param {{ platform: string, terminal: string, title: string, command: string }} opts
 * @returns {{ command: string, args: string[], options: object }|null}
 */
export function buildSpawnSpec({ platform, terminal, title, command }) {
  if (platform === 'win32') {
    // start 后首个引号参数是窗口标题位，置空改用 cmd 内部 title 命令设置
    // （避免 Node/libuv 参数转义与 start 标题解析的叠加坑）
    // 内层命令整体再包一层引号：cmd 收到 6 个引号时按 /k 的「剥离首尾引号」规则
    // 还原出 `title … && "node" "bin" gateway --port N && exit`，其中引号不再被 libuv 转义。
    // 尾部 `&& exit` 仅在网关正常退出（code 0）时执行：UI 关闭网关 / 窗口内 Ctrl+C
    // 均关窗；启动失败或崩溃（code != 0）短路到 /k 保持窗口，供用户看错误输出。
    return {
      command: 'cmd.exe',
      args: ['/c', 'start', '""', 'cmd', '/k', `"title ${title} && ${command} && exit"`],
      options: {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true, // 引号全部由本模块自管，禁止 libuv 二次转义
      },
    }
  }
  if (platform === 'darwin') {
    // printf 设置窗口标题；do script 在用户默认 shell 中执行
    const script = `printf '\\033]0;${title}\\007'; ${command}`
    return {
      command: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "${escapeAppleScript(script)}"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
      options: { stdio: 'ignore' },
    }
  }
  const t = LINUX_TERMINALS.find((x) => x.id === terminal)
  if (!t) return null
  return {
    command: t.probe,
    args: t.build(title, command),
    options: { detached: true, stdio: 'ignore' },
  }
}

/**
 * 在可见终端窗口中启动网关（启动器立即返回，网关存活以 /health 探测为准）
 * @param {object} options
 * @param {string} options.title - 窗口标题（建议带端口，如 "AI Gateway :8788"）
 * @param {string} options.execPath - node 可执行文件
 * @param {string} options.binPath - aigd.js 路径
 * @param {number} options.port
 * @param {string} [options.platform]
 * @param {object} [options.env]
 * @param {Function} [options.whichFn]
 * @param {Function} [options.spawnFn]
 * @returns {{ ok: boolean, method?: string, error?: string }}
 */
export function openInTerminal({
  title,
  execPath,
  binPath,
  port,
  platform = process.platform,
  env = process.env,
  whichFn,
  spawnFn = spawn,
}) {
  const start = Date.now()
  const which = whichFn || defaultWhich
  const terminal = detectTerminal({ platform, env, whichFn: which })
  if (!terminal) {
    const error =
      platform === 'win32' || platform === 'darwin'
        ? '当前平台不支持弹出终端窗口'
        : '未检测到桌面环境或可用的终端模拟器'
    logResult('gateway:window', { ok: false, message: error, elapsedMs: Date.now() - start })
    return { ok: false, error }
  }
  const command = buildGatewayCommand({ execPath, binPath, port, platform })
  const spec = buildSpawnSpec({ platform, terminal, title, command })
  if (!spec) {
    const error = `终端 ${terminal} 无对应启动规格`
    logResult('gateway:window', { ok: false, message: error, elapsedMs: Date.now() - start })
    return { ok: false, error }
  }
  try {
    const child = spawnFn(spec.command, spec.args, spec.options)
    if (typeof child.unref === 'function') child.unref()
    // 启动器（cmd start / osascript / 终端进程）异步失败不应崩主进程；
    // 网关是否就绪由 /health 探测判定，这里只负责把窗口弹出去
    if (typeof child.on === 'function') child.on('error', () => {})
    logResult('gateway:window', {
      ok: true,
      message: `${terminal} port=${port}`,
      elapsedMs: Date.now() - start,
    })
    return { ok: true, method: terminal }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logResult('gateway:window', {
      ok: false,
      message: `弹出失败：${message}`,
      elapsedMs: Date.now() - start,
    })
    return { ok: false, error: `弹出终端窗口失败：${message}` }
  }
}
