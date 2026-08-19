// 任务 11 验证脚本：setup.js 纯函数 + 假 token 全流程（无需真实凭证）
// 覆盖：writeProvidersFile（含跳过场景）/ backfillKVNamespaceId /
//       wrangler.toml 保持占位符不被污染 / 向导全流程失败分支不中断（假 token → 各 API 步骤失败但继续跑完）
//
// 注意：流程测试用 spawn + 逐行写入 stdin 驱动（Node readline/promises 在 stdin
//       EOF 后挂起 question，不能一次性灌入所有输入后立即关闭 stdin）。
//
// 测试隔离（2026-08-15 修复）：通过 AI_GW_TEST_DIR 将 token 存储重定向到
// 临时目录，**完全不触碰真实凭证**（~/.ai-gateway-desk/）。setup 向导写入的
// 假 token 只落在临时目录；即使测试中断（异常退出 / 超时 kill）也不会污染
// 真实凭证，无需备份/恢复逻辑。子进程 spawn 默认继承父进程 env，自动生效。
// 注意：env 必须在 import setup.js / token-store **之前**设置（模块求值时
// 读取），因此本文件用动态 import，而非顶层静态 import。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// 先创建临时目录并设置隔离 env，再加载被测模块
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-setup-test-'))
process.env.AI_GW_TEST_DIR = TEST_DIR

const {
  writeProvidersFile,
  backfillKVNamespaceId,
} = await import('../src/setup.js')
const { readManagementToken, readToken } = await import('../src/core/token-store.js')

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA_PROVIDERS = path.join(ROOT, 'data', 'providers.json')
const WRANGLER_TOML = path.join(ROOT, 'ai-gateway-desk-worker', 'wrangler.toml')
// 测试隔离模式下 token 存储指向临时目录（与 token-store 的 AI_GW_TEST_DIR 一致）
const TOKEN_DIR = TEST_DIR

// ─── 备份真实项目文件（测试后恢复） ───
// 仅备份会被测试改写的项目文件（providers.json / wrangler.toml）。
// 凭证无需备份：测试隔离模式下 token 存储已在临时目录（AI_GW_TEST_DIR），
// 即便测试中断也不会触碰真实凭证。
const backup = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null)
const saved = new Map([
  [DATA_PROVIDERS, backup(DATA_PROVIDERS)],
  [WRANGLER_TOML, backup(WRANGLER_TOML)],
])

const restore = () => {
  for (const [f, content] of saved) {
    try {
      if (content === null) {
        if (fs.existsSync(f)) fs.unlinkSync(f)
      } else {
        fs.writeFileSync(f, content)
      }
    } catch { /* 忽略恢复错误 */ }
  }
}

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ─── 真实凭证目录快照（隔离验证用） ───
// 对比测试运行前后 ~/.ai-gateway-desk/ 的文件集与内容是否一致：
// 一致 = 本次测试未触碰真实凭证；不一致 = 隔离失效（回归信号）
const REAL_TOKEN_DIR = path.join(os.homedir(), '.ai-gateway-desk')
const snapRealTokenDir = () => {
  if (!fs.existsSync(REAL_TOKEN_DIR)) return null
  const out = new Map()
  for (const f of fs.readdirSync(REAL_TOKEN_DIR)) out.set(f, fs.readFileSync(path.join(REAL_TOKEN_DIR, f)))
  return out
}
const realTokenDirBefore = snapRealTokenDir()

/**
 * spawn 子进程跑 runSetup，**prompt 驱动**写入 stdin：
 * 检测到 stdout 出现对应 prompt 后再写入该行答案。
 * （readline/promises 的 question 在非 TTY 管道下会丢失「挂起前到达」的输入行，
 *   不能按固定间隔预写输入）
 * @param {Array<[string, string]>} answers - [[prompt 关键字, 答案], ...] 按序匹配
 */
function runFlow(answers, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', "import { runSetup } from './src/setup.js'; await runSetup()"],
      { cwd: ROOT }
    )
    let out = ''
    let answered = new Set()
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, out: `${out}\n[FLOW TIMEOUT]` })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
    child.stdout.on('data', (d) => {
      out += d
      for (const [pattern, answer] of answers) {
        if (!answered.has(pattern) && out.includes(pattern)) {
          answered.add(pattern)
          try {
            child.stdin.write(`${answer}\n`)
          } catch { /* 子进程可能已退出 */ }
        }
      }
    })
    child.stderr.on('data', (d) => (out += d))
  })
}

try {
  // 备份文件原始 namespaceId（测试时 data/providers.json 存在）
  const orig = backup(DATA_PROVIDERS)
  const origNs = orig ? JSON.parse(orig.toString('utf8')).kv?.namespaceId : ''

  // ── 1. writeProvidersFile：全新写入（已有文件 → 保留 kv.namespaceId） ──
  writeProvidersFile({
    host: 'gateway.ai.cloudflare.com',
    accountId: 'acc-1',
    gatewayId: 'gw-1',
    providers: [{ id: 'p1', name: 'P1', enabled: true }],
  })
  let cfg = JSON.parse(fs.readFileSync(DATA_PROVIDERS, 'utf8'))
  check('writeProvidersFile accountId', cfg.gateway.accountId, 'acc-1')
  check('writeProvidersFile gatewayId', cfg.gateway.gatewayId, 'gw-1')
  check('writeProvidersFile host 保留', cfg.gateway.host, 'gateway.ai.cloudflare.com')
  check('writeProvidersFile providers', cfg.providers, [{ id: 'p1', name: 'P1', enabled: true }])
  check('writeProvidersFile kv.key 默认', cfg.kv.key, 'models')
  check('writeProvidersFile 保留 kv.namespaceId', cfg.kv.namespaceId, origNs)

  // ── 2. writeProvidersFile：providers=null（跳过）→ 保留本地已有 ──
  writeProvidersFile({ host: 'gateway.ai.cloudflare.com', accountId: 'acc-2', gatewayId: 'gw-2', providers: null })
  cfg = JSON.parse(fs.readFileSync(DATA_PROVIDERS, 'utf8'))
  check('跳过场景 保留本地 providers', cfg.providers, [{ id: 'p1', name: 'P1', enabled: true }])
  check('跳过场景 覆盖 accountId', cfg.gateway.accountId, 'acc-2')

  // ── 3. 新设计：setup 不再写入 wrangler.toml（占位符保持，真实 id 仅存 providers.json） ──
  //    部署时由 scripts/deploy.mjs 从 providers.json 动态注入临时配置
  const tomlBefore = fs.readFileSync(WRANGLER_TOML, 'utf8')
  check('wrangler.toml 模板含占位符', tomlBefore.includes('<YOUR_KV_NAMESPACE_ID>'), true)
  check('wrangler.toml 不含真实 id', !tomlBefore.includes('f1f0ad'), true)

  // ── 4. backfillKVNamespaceId：回填 providers.json（唯一数据源） ──
  backfillKVNamespaceId('new-kv-id-123')
  cfg = JSON.parse(fs.readFileSync(DATA_PROVIDERS, 'utf8'))
  check('回填 kv.namespaceId', cfg.kv.namespaceId, 'new-kv-id-123')
  check('回填后 wrangler.toml 未被修改', fs.readFileSync(WRANGLER_TOML, 'utf8'), tomlBefore)

  // ── 5. 假 token 全流程（子进程 + 逐行 stdin） ──
  // 清空 token 文件，确保子进程走「全新输入」分支
  fs.mkdirSync(TOKEN_DIR, { recursive: true })
  for (const f of ['token', 'token.management']) {
    const p = path.join(TOKEN_DIR, f)
    if (fs.existsSync(p)) fs.unlinkSync(p)
  }
  const { code, out } = await runFlow([
    ['[1/7]', 'test-mgmt-token'],
    ['[2/7]', 'test-account'],
    ['[3/7]', ''],
    ['粘贴 cfut_xxx', 'test-cfut-token'],
    ['添加 Provider', 'q'],
  ])
  check('流程 exit code 0', code, 0)
  check('流程输出含汇总', out.includes('Setup 汇总'), true)
  check('流程输出含各步骤', out.includes('各步骤结果'), true)
  check('流程 e 步执行', out.includes('5. Provider'), true)
  check('流程含失败步骤提示', out.includes('存在失败步骤'), true) // 假 token 下 API 步骤必然失败

  // 子进程 e 步写入的文件
  cfg = JSON.parse(fs.readFileSync(DATA_PROVIDERS, 'utf8'))
  check('流程后 accountId 已写入', cfg.gateway.accountId, 'test-account')
  check('流程后 providers 为空数组', Array.isArray(cfg.providers) && cfg.providers.length === 0, true)

  // 子进程写入的凭证（确认各步消费了正确输入，非竞态错位）
  check('流程 a 步写入 mgmt token', readManagementToken(), 'test-mgmt-token')
  check('流程 d 步写入 gateway token', readToken(), 'test-cfut-token')

  // ── 6. aigd.js setup 子命令接线（启动向导） ──
  const child2 = spawn(process.execPath, ['src/bin/aigd.js', 'setup'], { cwd: ROOT })
  let out2 = ''
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      child2.kill()
      resolve()
    }, 10_000)
    child2.stdout.on('data', (d) => {
      out2 += d
      if (out2.includes('[1/7]')) {
        clearTimeout(t)
        child2.kill()
        resolve()
      }
    })
    child2.on('close', () => {
      clearTimeout(t)
      resolve()
    })
  })
  check('aigd setup 启动向导', out2.includes('[1/7]'), true)

  console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
} finally {
  restore()
  // 隔离验证：假 token 只写入临时目录，真实凭证目录未被本次测试触碰
  // 关键断言：运行前后真实目录（~/.ai-gateway-desk/）内容一致。
  // 不要求真实目录为空——用户可能已有真实凭证（或有历史测试残留），
  // 只要**本次测试没有改写**它们即证明隔离生效。
  check('测试临时目录写入 token 文件', fs.existsSync(TOKEN_DIR) && fs.readdirSync(TOKEN_DIR).some((f) => f.startsWith('token')), true)
  const realAfter = snapRealTokenDir()
  const sameReal =
    (realTokenDirBefore === null && realAfter === null) ||
    (realTokenDirBefore !== null && realAfter !== null &&
      realTokenDirBefore.size === realAfter.size &&
      [...realTokenDirBefore.entries()].every(([f, buf]) => realAfter.has(f) && buf.equals(realAfter.get(f))))
  check('真实凭证目录未被测试改写', sameReal, true)
  // 清理临时目录（即使断言失败也执行）
  try {
    fs.rmSync(TOKEN_DIR, { recursive: true, force: true })
  } catch { /* 忽略清理错误 */ }
}
process.exit(failed ? 1 : 0)
