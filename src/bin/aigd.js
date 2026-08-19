#!/usr/bin/env node

/**
 * aigd — 统一 CLI 入口
 *
 * 用法：
 *   node src/bin/aigd.js web       启动本地 Web 管理界面（默认）
 *   node src/bin/aigd.js sync      同步模型（规划中，任务 11）
 *   node src/bin/aigd.js deploy    部署到 KV（规划中，任务 11）
 *   node src/bin/aigd.js setup     初始化向导（规划中，任务 11）
 *
 * @module ai-gateway-desk/src/bin/aigd
 */

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { realpathSync } from 'node:fs'

const __filename = fileURLToPath(import.meta.url)

const HELP = `
aigd — AI Gateway 模型管理工具

用法:
  aigd web        启动本地 Web 管理界面（默认）
  aigd sync       同步模型列表（规划中）
  aigd deploy     部署模型列表到 KV（规划中）
  aigd setup      初始化向导（建 gateway / 存凭证 / provider / KV）
  aigd help       显示帮助
`

const PLANNED = new Set(['sync', 'deploy'])

async function main() {
  const cmd = process.argv[2] || 'web'

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP)
    return
  }

  if (PLANNED.has(cmd)) {
    console.log(`[aigd] 子命令 "${cmd}" 规划中，当前请使用 "setup"。`)
    return
  }

  if (cmd === 'setup') {
    const { runSetup } = await import('../setup.js')
    await runSetup()
    return
  }

  if (cmd === 'web') {
    // Web 管理服务器：交互式初始化引导不适合 HTTP 场景（初始化请用 setup 子命令）
    const { startServer } = await import('../web/server.js')
    const { url } = await startServer({ openBrowser: !process.env.AIGD_NO_OPEN })
    console.log(`[aigd] Web 管理界面已启动: ${url}`)
    console.log('按 Ctrl+C 退出')
    return
  }

  console.log(`[aigd] 未知子命令: ${cmd}`)
  console.log(HELP)
  process.exitCode = 1
}

// ─── CLI 入口保护 ────────────────────────────────────────
// 被 import 时不执行（如测试），仅直接运行时进入 main()
// realpath 兜底：npm 全局安装的 bin 可能经符号链接/junction 路径调用
// （如 Windows nvm 的 node_modules 目录链接），此时 argv[1] 与 __filename
// （import.meta.url 已解析为真实路径）字符串不等，需比较解析后路径。

function safeRealpath(p) {
  try {
    return realpathSync(p)
  } catch {
    // 文件不存在（如 argv 是普通参数）时 realpathSync 抛错，回退 resolve
    return path.resolve(p)
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === __filename ||
  path.resolve(process.argv[1]) === __filename ||
  safeRealpath(process.argv[1]) === safeRealpath(__filename)
)

if (isMain) {
  main()
}
