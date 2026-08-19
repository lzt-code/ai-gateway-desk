/**
 * wrangler 部署/开发包装脚本 — 动态注入 KV namespace id
 * @module ai-gateway-desk/scripts/deploy
 *
 * 背景（2026-08-09 设计修正）：
 *   之前 setup 向导的 f 步会直接把真实 KV namespace id 写入被 git 跟踪的
 *   ai-gateway-desk-worker/wrangler.toml（占位符文件），导致每次运行 setup 后
 *   工作区变脏，且真实 id 有被误提交的风险。
 *
 * 新设计：
 *   - ai-gateway-desk-worker/wrangler.toml 永远是占位符模板（id = "<YOUR_KV_NAMESPACE_ID>"），
 *     不写入任何真实值，git 永远干净
 *   - 真实 KV namespace id 唯一存放在 data/providers.json 的 kv.namespaceId
 *     （setup 向导 f 步只回填这里）
 *   - 部署 / 本地开发时运行本脚本：读 providers.json → 替换占位符 → 生成临时配置
 *     ai-gateway-desk-worker/.wrangler.generated.toml → 调 wrangler → 用完删除
 *
 * 用法：
 *   node scripts/deploy.mjs deploy   部署 Worker（默认）
 *   node scripts/deploy.mjs dev      本地开发（长驻，退出时清理临时配置）
 *
 * 注意：
 *   - wrangler 用根 node_modules/.bin 下的本地 wrangler（devDependency）
 *   - account 上下文由 wrangler login 或 CLOUDFLARE_ACCOUNT_ID 环境变量提供
 *     （wrangler.toml 注释已说明，本脚本不涉及）
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** scripts/ → 项目根 */
const ROOT = path.resolve(__dirname, '..')
const PROVIDERS_PATH = path.join(ROOT, 'data', 'providers.json')
const TEMPLATE_PATH = path.join(ROOT, 'ai-gateway-desk-worker', 'wrangler.toml')
const TMP_CONFIG_PATH = path.join(ROOT, 'ai-gateway-desk-worker', '.wrangler.generated.toml')

export const KV_PLACEHOLDER = '<YOUR_KV_NAMESPACE_ID>'
export const ACCOUNT_ID_PLACEHOLDER = '{{ACCOUNT_ID}}'
export const GATEWAY_ID_PLACEHOLDER = '{{GATEWAY_ID}}'

/**
 * 从 wrangler.toml 模板生成注入真实 KV id 的配置内容（纯函数，便于测试）
 * @param {string} template - wrangler.toml 模板内容
 * @param {string} namespaceId - 真实 KV namespace id
 * @param {string} [placeholder] - 占位符，默认 <YOUR_KV_NAMESPACE_ID>
 * @returns {string} 替换后的配置内容
 * @throws 模板中不存在占位符时抛错（避免覆盖已有真实值 / 双 id）
 */
export function buildWranglerConfig(template, namespaceId, placeholder = KV_PLACEHOLDER) {
  if (!namespaceId) {
    throw new Error('KV namespace id 为空')
  }
  if (!template.includes(placeholder)) {
    throw new Error(`wrangler.toml 模板中未找到占位符 ${placeholder}，请确保以占位符形式提交（勿写入真实 id）`)
  }
  return template.replace(placeholder, namespaceId)
}

/**
 * 从 wrangler.toml 模板生成注入 gateway 配置内容（纯函数，便于测试）
 * @param {string} template - wrangler.toml 模板内容
 * @param {{ accountId: string, gatewayId: string }} gateway - gateway 配置对象
 * @returns {string} 替换后的配置内容
 * @throws 模板中缺少占位符时抛错
 */
export function buildGatewayConfig(template, gateway) {
  if (!gateway || typeof gateway !== 'object') {
    throw new Error('gateway 配置对象为空')
  }
  const { accountId, gatewayId } = gateway
  if (!accountId || !gatewayId) {
    throw new Error('gateway 配置缺少 accountId 或 gatewayId')
  }
  if (!template.includes(ACCOUNT_ID_PLACEHOLDER)) {
    throw new Error(`wrangler.toml 模板中未找到占位符 ${ACCOUNT_ID_PLACEHOLDER}`)
  }
  if (!template.includes(GATEWAY_ID_PLACEHOLDER)) {
    throw new Error(`wrangler.toml 模板中未找到占位符 ${GATEWAY_ID_PLACEHOLDER}`)
  }
  return template
    .replace(ACCOUNT_ID_PLACEHOLDER, accountId)
    .replace(GATEWAY_ID_PLACEHOLDER, gatewayId)
}

/**
 * 解析 wrangler 可执行文件（Windows .cmd 需经 cmd /c）
 * @returns {{ command: string, args: string[] }}
 */
function resolveWrangler() {
  const isWin = process.platform === 'win32'
  const bin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'wrangler.cmd' : 'wrangler')
  const fallback = isWin ? 'wrangler.cmd' : 'wrangler'
  if (isWin) {
    return { command: 'cmd.exe', args: ['/d', '/c', existsSync(bin) ? bin : fallback] }
  }
  return { command: existsSync(bin) ? bin : fallback, args: [] }
}

function main() {
  const mode = process.argv[2] || 'deploy'
  if (mode !== 'deploy' && mode !== 'dev') {
    console.error(`[wrangler] 未知模式: ${mode}（支持 deploy / dev）`)
    process.exit(1)
  }

  // 1. 读 data/providers.json 的 kv.namespaceId / gateway.accountId / gateway.gatewayId
  let providersData = {}
  if (existsSync(PROVIDERS_PATH)) {
    try {
      providersData = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf8')) || {}
    } catch {
      // 解析失败按空处理
    }
  }
  const namespaceId = providersData.kv?.namespaceId || ''
  const gateway = providersData.gateway || {}
  const accountId = gateway.accountId || ''
  const gatewayId = gateway.gatewayId || ''

  if (!namespaceId) {
    console.error(`[wrangler-${mode}] 未找到 KV namespace id（data/providers.json 的 kv.namespaceId 为空）。`)
    console.error('  请先运行 npm run aigd setup（向导第 6 步自动创建 KV 并回填），')
    console.error('  或手动在 data/providers.json 填写 kv.namespaceId 后重试。')
    process.exit(1)
  }
  if (!accountId || !gatewayId) {
    console.error(`[wrangler-${mode}] 未找到 gateway 配置（data/providers.json 的 gateway.accountId / gateway.gatewayId 为空）。`)
    console.error('  请先运行 npm run aigd setup（向导第 2 步填写 Account ID 和第 3 步填写 Gateway ID），')
    console.error('  或手动在 data/providers.json 填写 gateway 配置后重试。')
    process.exit(1)
  }

  // 2. 生成临时配置（不修改模板源文件）
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
  let config
  try {
    config = buildWranglerConfig(template, namespaceId)
    config = buildGatewayConfig(config, { accountId, gatewayId })
  } catch (err) {
    console.error(`[wrangler-${mode}] ${err.message}`)
    process.exit(1)
  }
  writeFileSync(TMP_CONFIG_PATH, config)

  // 3. 调 wrangler
  const { command, args } = resolveWrangler()

  if (mode === 'deploy') {
    const r = spawnSync(command, [...args, 'deploy', '-c', TMP_CONFIG_PATH], {
      stdio: 'inherit',
      cwd: ROOT,
    })
    cleanupTmp()
    process.exit(r.status ?? 1)
  }

  // dev：长驻进程，退出后清理临时配置
  const child = spawn(command, [...args, 'dev', '-c', TMP_CONFIG_PATH], {
    stdio: 'inherit',
    cwd: ROOT,
  })
  child.on('close', (code) => {
    cleanupTmp()
    process.exit(code ?? 0)
  })
}

function cleanupTmp() {
  try {
    unlinkSync(TMP_CONFIG_PATH)
  } catch {
    // 已删除 / 不存在，忽略
  }
}

// ─── CLI 入口保护 ────────────────────────────────────────
const isMain = process.argv[1] && (
  process.argv[1] === __filename ||
  path.resolve(process.argv[1]) === __filename
)

if (isMain) {
  main()
}
