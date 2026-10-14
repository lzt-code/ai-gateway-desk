/**
 * Web 初始化引导（onboarding）逻辑层
 * @module ai-gateway-desk/src/logic/onboarding
 *
 * 取代已废弃的终端初始化向导（src/setup.js）。触发条件：本机没有管理 API Token
 * （见 isInitialized）时，Web 界面自动进入引导。
 *
 * 两条路径：
 *   A. 没有 Cloudflare 账号 → 前端引导注册 + 创建管理 Token（纯文案，无后端）
 *   B. 已经用过 aigd / 已有账号 → 填两个 Token，本模块负责：
 *      discoverOnboarding：用管理 Token 解析 accountId + 列出已有 Gateway
 *      completeOnboarding：确认/创建 Gateway → 验证 cfut_xxx → 保存双 Token
 *                          → 查找/创建 KV namespace → 写 data/providers.json
 *
 * 所有编排依赖均可注入（默认绑定真实 cloudflare/api.js / core 模块），便于单测。
 * 每一步独立 try/catch：网关 / 验证 / 落盘为关键步骤（失败即整体失败、不落盘半成品），
 * KV 为尽力而为（失败仅告警，不影响引导完成）。
 */

import {
  createGateway,
  createKVNamespace,
  listAccounts,
  listGateways,
  listKVNamespaces,
  verifyGatewayToken,
} from '../cloudflare/api.js'
import {
  mergeProvidersConfig,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_ID,
  DEFAULT_KV_KEY,
} from '../core/providers-config.js'
import { writeManagementToken, writeToken } from '../core/token-store.js'
import { logResult as ioLogResult } from '../core/io-logger.js'

/** KV namespace 标题（与旧终端向导一致：创建/查找 models-kv） */
export const KV_NAMESPACE_TITLE = 'models-kv'

/**
 * 是否已初始化（判定依据：有管理 API Token 即视为已初始化）
 *
 * env 提供的管理 Token（CLOUDFLARE_API_TOKEN）优先，其次本地安全存储。
 * @param {object} input
 * @param {string|null|undefined} input.envManagement - 环境变量 CLOUDFLARE_API_TOKEN
 * @param {string|null|undefined} input.localManagement - 本地管理槽位（readManagementToken）
 * @returns {boolean}
 */
export function isInitialized({ envManagement, localManagement } = {}) {
  const has = (v) => typeof v === 'string' && v.trim() !== ''
  return has(envManagement) || has(localManagement)
}

// ─── 路径 B-1：解析账户 + 列网关 ─────────────────────────

/**
 * 用管理 Token 解析账户与网关（供引导表单展示）
 *
 * @param {object} input
 * @param {string} input.managementToken - 管理 API Token
 * @param {string} [input.accountId] - 用户已选账户（多账户场景）；缺省取第一个
 * @param {object} [deps]
 * @param {Function} [deps.listAccountsFn]
 * @param {Function} [deps.listGatewaysFn]
 * @returns {Promise<{ ok: boolean, accounts?: Array, accountId?: string, gateways?: Array, error?: string }>}
 */
export async function discoverOnboarding({ managementToken, accountId } = {}, deps = {}) {
  const {
    listAccountsFn = listAccounts,
    listGatewaysFn = listGateways,
  } = deps
  const op = 'onboarding:discover'
  const start = Date.now()
  if (!managementToken || !String(managementToken).trim()) {
    return { ok: false, error: '请填写管理 API Token' }
  }
  try {
    const accounts = await listAccountsFn(String(managementToken).trim())
    if (!Array.isArray(accounts) || accounts.length === 0) {
      ioLogResult(op, { ok: false, message: '未找到可访问的账户', elapsedMs: Date.now() - start })
      return { ok: false, error: '该 Token 下未找到可访问的账户（请确认令牌为账户级且有效）', accounts: [] }
    }
    const picked = (accountId && accounts.some((a) => a.id === accountId)) ? accountId : accounts[0].id
    const gateways = await listGatewaysFn(String(managementToken).trim(), picked)
    ioLogResult(op, {
      ok: true,
      message: `accounts=${accounts.length} accountId=${picked} gateways=${gateways.length}`,
      elapsedMs: Date.now() - start,
    })
    return { ok: true, accounts, accountId: picked, gateways }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ioLogResult(op, { ok: false, message, elapsedMs: Date.now() - start })
    return { ok: false, error: message }
  }
}

// ─── 路径 B-2：完成配置 ──────────────────────────────────

/**
 * 完成初始化：确认/创建 Gateway → 验证 cfut → 保存双 Token → KV → 写配置
 *
 * @param {object} input
 * @param {string} input.managementToken - 管理 API Token
 * @param {string} input.accountId - Cloudflare 账户 ID
 * @param {string} [input.gatewayId] - gateway id（缺省 cf-ai-gateway）
 * @param {string} input.gatewayToken - cfut_xxx（Gateway Token）
 * @param {string} [input.host] - AI Gateway 主机（缺省 gateway.ai.cloudflare.com）
 * @param {object} [deps]
 * @returns {Promise<{ ok: boolean, steps: Array, gatewayId?: string, kvNamespaceId?: string, error?: string, warnings?: string[] }>}
 */
export async function completeOnboarding(input = {}, deps = {}) {
  const {
    createGatewayFn = createGateway,
    verifyGatewayTokenFn = verifyGatewayToken,
    writeManagementFn = writeManagementToken,
    writeGatewayFn = writeToken,
    listKVNamespacesFn = listKVNamespaces,
    createKVNamespaceFn = createKVNamespace,
    mergeProvidersConfigFn = mergeProvidersConfig,
  } = deps

  const managementToken = typeof input.managementToken === 'string' ? input.managementToken.trim() : ''
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : ''
  const gatewayId = (typeof input.gatewayId === 'string' && input.gatewayId.trim()) || DEFAULT_GATEWAY_ID
  const gatewayToken = typeof input.gatewayToken === 'string' ? input.gatewayToken.trim() : ''
  const host = (typeof input.host === 'string' && input.host.trim()) || DEFAULT_GATEWAY_HOST

  const steps = []
  const warnings = []
  const t0 = Date.now()

  if (!managementToken) return { ok: false, error: '缺少管理 API Token', steps }
  if (!accountId) return { ok: false, error: '缺少 Account ID（请先点击「读取账号」）', steps }
  if (!gatewayToken) return { ok: false, error: '请填写 cfut_xxx（Gateway Token）', steps }

  // ── 关键步骤 1：确认 / 创建 Gateway（幂等）──
  try {
    await createGatewayFn(managementToken, accountId, gatewayId)
    steps.push({ step: 'Gateway', ok: true, message: `已就绪（${gatewayId}）` })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    steps.push({ step: 'Gateway', ok: false, message })
    ioLogResult('onboarding:complete', { ok: false, message: `gateway ${message}`, elapsedMs: Date.now() - t0 })
    return { ok: false, error: `创建/确认 Gateway 失败：${message}`, steps }
  }

  // ── 关键步骤 2：验证 cfut_xxx ──
  try {
    const verified = await verifyGatewayTokenFn(host, accountId, gatewayId, gatewayToken)
    if (!verified) throw new Error('令牌验证失败（请确认 token 已创建且绑定该 gateway）')
    steps.push({ step: 'cfut_xxx', ok: true, message: '已验证 ✓' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    steps.push({ step: 'cfut_xxx', ok: false, message })
    ioLogResult('onboarding:complete', { ok: false, message: `cfut ${message}`, elapsedMs: Date.now() - t0 })
    return { ok: false, error: `Gateway Token 验证失败：${message}`, steps }
  }

  // ── 关键步骤 3：保存双 Token（验证通过后才落盘，避免半成品状态）──
  try {
    writeManagementFn(managementToken)
    writeGatewayFn(gatewayToken)
    steps.push({ step: '凭证', ok: true, message: '管理 + Gateway Token 已保存到本地安全存储' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    steps.push({ step: '凭证', ok: false, message })
    ioLogResult('onboarding:complete', { ok: false, message: `token write ${message}`, elapsedMs: Date.now() - t0 })
    return { ok: false, error: `保存凭证失败：${message}`, steps }
  }

  // ── 尽力而为：KV namespace（查找既有 models-kv，否则创建）→ 写 providers.json ──
  let kvNamespaceId = ''
  try {
    const namespaces = await listKVNamespacesFn(managementToken, accountId)
    const existing = (Array.isArray(namespaces) ? namespaces : []).find((n) => n && n.title === KV_NAMESPACE_TITLE)
    if (existing) {
      kvNamespaceId = existing.id
      steps.push({ step: 'KV namespace', ok: true, message: `复用既有 ${KV_NAMESPACE_TITLE}（${existing.id}）` })
    } else {
      const created = await createKVNamespaceFn(managementToken, accountId, KV_NAMESPACE_TITLE)
      kvNamespaceId = (created && created.id) || ''
      steps.push({ step: 'KV namespace', ok: true, message: `已创建 ${KV_NAMESPACE_TITLE}（${kvNamespaceId}）` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`KV namespace 未配置：${message}`)
    steps.push({ step: 'KV namespace', ok: false, message: `跳过（${message}）` })
  }

  try {
    mergeProvidersConfigFn({
      gateway: { host, accountId, gatewayId },
      ...(kvNamespaceId ? { kv: { namespaceId: kvNamespaceId, key: DEFAULT_KV_KEY } } : {}),
    })
    steps.push({ step: '配置', ok: true, message: '已写入 data/providers.json' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push(`providers.json 写入失败：${message}`)
    steps.push({ step: '配置', ok: false, message: `写入失败：${message}` })
  }

  ioLogResult('onboarding:complete', {
    ok: true,
    message: `accountId=${accountId} gateway=${gatewayId} kv=${kvNamespaceId || '(无)'}`,
    elapsedMs: Date.now() - t0,
  })
  return { ok: true, steps, gatewayId, kvNamespaceId, warnings }
}
