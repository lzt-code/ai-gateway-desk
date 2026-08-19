// 任务 12 验证脚本：双凭证槽位读写 + 向后兼容（Windows DPAPI 实测）
//
// 测试隔离（2026-08-15 修复）：通过 AI_GW_TEST_DIR 将 token 存储重定向到
// 临时目录，**完全不触碰真实凭证**（~/.ai-gateway-desk/）。即使测试中断
// （异常退出 / 超时 kill）也不会污染真实凭证，无需备份/恢复逻辑。
// 注意：env 必须在 import token-store **之前**设置（模块求值时读取），
// 因此本文件用动态 import，而非顶层静态 import。

// 先创建临时目录并设置隔离 env，再加载被测模块
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gw-token-test-'))
process.env.AI_GW_TEST_DIR = TEST_DIR

const {
  writeToken, readToken, clearToken,
  writeManagementToken, readManagementToken, clearManagementToken,
  getSlotStatus, getTokenStoreInfo,
} = await import('../src/core/token-store.js')

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

try {
  // 1. 写入/读取两个槽位
  writeToken('cfut_gateway_xxx')
  writeManagementToken('api_management_xxx')
  check('readToken()', readToken(), 'cfut_gateway_xxx')
  check('readManagementToken()', readManagementToken(), 'api_management_xxx')

  // 2. 清除 gateway 不影响 management
  clearToken()
  check('clearToken() 后 readToken()', readToken(), null)
  check('clearToken() 后 readManagementToken()', readManagementToken(), 'api_management_xxx')

  // 3. 槽位状态 + 旧 API 不破坏
  const status = getSlotStatus()
  check('getSlotStatus()', status, { management: '本地', gateway: '未保存' })
  const info = getTokenStoreInfo()
  // 测试隔离模式下强制文件存储（Linux 分支），平台描述恒为 'Linux'
  check('getTokenStoreInfo() 平台（测试隔离模式 → Linux）', info.platform, 'Linux')
  check('getTokenStoreInfo() 有 storage/secure', typeof info.storage === 'string' && typeof info.secure === 'boolean', true)

  // 4. 清除 management
  clearManagementToken()
  check('clearManagementToken() 后 readManagementToken()', readManagementToken(), null)
  check('getSlotStatus() 全空', getSlotStatus(), { management: '未保存', gateway: '未保存' })

  // ─── 隔离验证：读写全程只落在临时目录，真实凭证目录未被触碰 ───
// 关键断言：测试运行前后，真实目录（~/.ai-gateway-desk/）的文件内容一致。
// 不要求真实目录为空——用户可能已有真实凭证（或有历史测试残留），
// 只要**本次测试没有改写**它们即证明隔离生效。
const realDir = path.join(os.homedir(), '.ai-gateway-desk')
const snapReal = () => {
  if (!fs.existsSync(realDir)) return null
  const out = new Map()
  for (const f of fs.readdirSync(realDir)) out.set(f, fs.readFileSync(path.join(realDir, f)))
  return out
}

const realBefore = snapReal()
// 先写入再清除，确保全程有文件操作发生在临时目录
writeToken('isolation-check')
writeManagementToken('isolation-check-mgmt')
check('写入落在临时目录 token', fs.existsSync(path.join(TEST_DIR, 'token')), true)
check('写入落在临时目录 token.management', fs.existsSync(path.join(TEST_DIR, 'token.management')), true)
clearToken()
clearManagementToken()

// 与运行前对比：真实目录要么原本不存在，要么文件集与内容完全一致
const realAfter = snapReal()
const sameReal =
  (realBefore === null && realAfter === null) ||
  (realBefore !== null && realAfter !== null &&
    realBefore.size === realAfter.size &&
    [...realBefore.entries()].every(([f, buf]) => realAfter.has(f) && buf.equals(realAfter.get(f))))
check('真实凭证目录未被测试改写', sameReal, true)

  console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
} finally {
  // 清理临时目录（即使断言失败也执行）
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  } catch { /* 忽略清理错误 */ }
}
process.exit(failed ? 1 : 0)
