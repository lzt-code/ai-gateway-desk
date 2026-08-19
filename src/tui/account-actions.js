/**
 * Worker / 账户视图纯逻辑（任务 21）
 * @module ai-gateway-desk/src/tui/account-actions
 *
 * 背景：任务 18 四视图框架中 [3] Worker 与 [4] 账户视图由本任务实现。
 *   - Worker 视图（[3]）：状态展示（KV namespace id / models.json / KV key 存在性）
 *     + 部署（调 scripts/deploy.mjs，Worker 代码不可改，仅管理部署）
 *   - 账户视图（[4]）：双 token 槽位（管理 API Token + Gateway Token）更新 / 清除，
 *     清除前确认影响面；gateway 信息展示
 *
 * 本模块**不依赖 blessed**：token 状态汇总 / gateway 信息 / Worker 状态构建等
 * 纯逻辑可独立单测（见 test/test-account-view.mjs）；更新 / 清除编排与 KV key
 * 检查支持依赖注入（默认绑定真实 token-store / wrangler）。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  writeToken,
  clearToken,
  writeManagementToken,
  clearManagementToken,
} from '../core/token-store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ─── 槽位常量 ────────────────────────────────────────────

export const SLOTS = Object.freeze({
  MANAGEMENT: 'management', // 管理 API Token（账户级，绝不分发）
  GATEWAY: 'gateway', // Gateway Token（cfut_xxx，绑定单 gateway）
})

// ─── Token 状态汇总 ──────────────────────────────────────

/**
 * 汇总两个凭证槽位的展示状态（纯函数，不读取任何外部状态）
 *
 * 来源优先级：env（临时）> 本地安全存储 > 无。
 * 返回结构化展示信息，供 views.js buildAccountLines 渲染：
 *   source: 'env' | 'local' | 'none' —— 当前生效来源
 *   hasLocal: boolean —— 本地安全存储是否已有
 *   label: 展示文本（如「env 提供」「本地已存」「未配置」）
 *   mark: '●'（有可用凭证）| '○'（无）
 *
 * @param {object} input
 * @param {string|null|undefined} input.envManagement - 环境变量 CLOUDFLARE_API_TOKEN
 * @param {string|null|undefined} input.envGateway - 环境变量 GATEWAY_TOKEN
 * @param {string|null} input.localManagement - 本地管理槽位（readManagementToken 结果）
 * @param {string|null} input.localGateway - 本地 gateway 槽位（readToken 结果）
 * @returns {{
 *   management: { source: string, hasLocal: boolean, label: string, mark: string },
 *   gateway: { source: string, hasLocal: boolean, label: string, mark: string },
 * }}
 */
export function summarizeTokenStatus({ envManagement, envGateway, localManagement, localGateway } = {}) {
  const build = (env, local) => {
    const hasLocal = Boolean(local)
    if (env) {
      return { source: 'env', hasLocal, label: 'env 提供', mark: '●' }
    }
    if (hasLocal) {
      return { source: 'local', hasLocal, label: '本地已存', mark: '●' }
    }
    return { source: 'none', hasLocal: false, label: '未配置', mark: '○' }
  }
  return {
    management: build(envManagement, localManagement),
    gateway: build(envGateway, localGateway),
  }
}

// ─── Gateway 信息汇总 ────────────────────────────────────

/**
 * 汇总 gateway 配置信息（纯函数）
 *
 * config.gateway 缺失 / 字段缺失时显示「未配置」，不抛错。
 *
 * @param {object|null|undefined} gateway - loadConfig() 返回的 config.gateway
 * @returns {{ accountId: string, gatewayId: string }} 缺失字段为「未配置」
 */
export function summarizeGatewayInfo(gateway) {
  const g = gateway && typeof gateway === 'object' ? gateway : {}
  return {
    accountId: g.accountId || '未配置',
    gatewayId: g.gatewayId || '未配置',
  }
}

// ─── Token 更新 / 清除编排 ───────────────────────────────

/**
 * 更新指定槽位的 Token（安全存储写入）
 *
 * 依赖以命名参数注入（默认绑定真实 token-store），测试可传 mock。
 *
 * @param {string} slot - SLOTS.MANAGEMENT | SLOTS.GATEWAY
 * @param {string} token - 新 Token；空 / 空白视为取消
 * @param {object} [deps]
 * @param {Function} [deps.writeManagementFn] - 默认 writeManagementToken
 * @param {Function} [deps.writeGatewayFn] - 默认 writeToken
 * @returns {{ ok: boolean, skipped?: boolean, error?: Error }}
 *   skipped: 空 token（取消）；error: 写入失败
 */
export function updateToken(slot, token, deps = {}) {
  const {
    writeManagementFn = writeManagementToken,
    writeGatewayFn = writeToken,
  } = deps

  if (!token || !String(token).trim()) {
    return { ok: false, skipped: true }
  }

  try {
    if (slot === SLOTS.MANAGEMENT) {
      writeManagementFn(String(token).trim())
    } else {
      writeGatewayFn(String(token).trim())
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * 清除指定槽位的本地 Token（仅清指定槽位，不影响另一槽位）
 *
 * @param {string} slot - SLOTS.MANAGEMENT | SLOTS.GATEWAY
 * @param {object} [deps]
 * @param {Function} [deps.clearManagementFn] - 默认 clearManagementToken
 * @param {Function} [deps.clearGatewayFn] - 默认 clearToken
 * @returns {{ ok: boolean, error?: Error }}
 */
export function clearSlotToken(slot, deps = {}) {
  const {
    clearManagementFn = clearManagementToken,
    clearGatewayFn = clearToken,
  } = deps

  try {
    if (slot === SLOTS.MANAGEMENT) {
      clearManagementFn()
    } else {
      clearGatewayFn()
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

// ─── Worker 视图状态 ─────────────────────────────────────

/**
 * 构建 Worker 视图状态（纯函数，输入由调用方读取）
 *
 * @param {object} input
 * @param {string} input.namespaceId - data/providers.json 的 kv.namespaceId（可为空串）
 * @param {{ exists: boolean, count: number|null }} input.modelsJson - data/models.json 状态
 * @param {string} input.kvKey - KV key 检查结果：'exists' | 'error' | 'skipped'
 * @param {string} [input.kvKeyName] - KV key 名称（默认 'models'，仅展示用）
 * @returns {{
 *   kvNamespace: { configured: boolean, id: string },
 *   modelsJson: { exists: boolean, count: number|null },
 *   kvKey: { status: string, detail: string },
 *   canDeploy: boolean,
 * }}
 */
export function buildWorkersStatus({ namespaceId = '', modelsJson = {}, kvKey = 'skipped', kvKeyName = 'models' } = {}) {
  const id = namespaceId || ''
  const mj = {
    exists: Boolean(modelsJson.exists),
    count: typeof modelsJson.count === 'number' ? modelsJson.count : null,
  }

  let kvDetail
  if (kvKey === 'exists') {
    kvDetail = `存在`
  } else if (kvKey === 'error') {
    kvDetail = '无法读取'
  } else {
    kvDetail = '未检查（未配置 KV）'
  }

  return {
    kvNamespace: { configured: Boolean(id), id },
    modelsJson: mj,
    kvKey: { status: kvKey, detail: kvDetail },
    // 部署前置：仅需要 KV namespace 已配置（models.json 仅影响 KV key 部署，不影响 Worker 部署）
    canDeploy: Boolean(id),
  }
}

// ─── KV key 存在性检查（wrangler kv:key get）──────────────

/** 解析 wrangler 命令（Windows .cmd 经 cmd /c），与 deploy.js 同模式 */
function resolveWranglerCommand() {
  const localWrangler = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'wrangler.cmd')
  const isWin = process.platform === 'win32'
  if (isWin) {
    const cmdPath = existsSync(localWrangler) ? localWrangler : 'wrangler.cmd'
    return { command: 'cmd.exe', args: ['/d', '/c', cmdPath] }
  }
  const unix = localWrangler.replace(/\.cmd$/, '')
  return { command: existsSync(unix) ? unix : 'wrangler', args: [] }
}

/**
 * 检查 KV 中指定 key 是否存在（wrangler kv:key get）
 *
 * 失败（未登录 / 网络 / key 不存在）统一返回 'error'，显示「无法读取」。
 * 依赖注入 execFileFn 便于测试。
 *
 * @param {string} namespaceId - KV namespace id
 * @param {string} key - KV key 名称
 * @param {object} [deps]
 * @param {Function} [deps.execFileFn] - 默认 node:child_process execFile
 * @returns {Promise<'exists'|'error'|'skipped'>} skipped：namespaceId 为空（未配置）
 */
export async function checkKVKey(namespaceId, key, deps = {}) {
  const { execFileFn = execFile } = deps
  if (!namespaceId || !key) return 'skipped'

  const { command, args: cmdArgs } = resolveWranglerCommand()
  return new Promise((resolve) => {
    execFileFn(
      command,
      [...cmdArgs, 'kv:key', 'get', '--namespace-id', namespaceId, key],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (err) => {
        resolve(err ? 'error' : 'exists')
      }
    )
  })
}
