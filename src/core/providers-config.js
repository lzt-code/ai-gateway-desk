/**
 * data/providers.json 读写（gateway / kv / providers 三块）
 *
 * 从原终端初始化向导（src/setup.js）抽出的纯文件逻辑，供 Web 初始化引导复用：
 *   - mergeProvidersConfig：合并写入 gateway / kv（providers 数组与未知字段原样保留）
 *   - backfillKVNamespaceId：仅回填 kv.namespaceId（KV 创建后调用）
 *
 * 约定：写前自动备份原文件为 providers.json.bak（原文件不存在时跳过备份），
 *       与 logic/provider-actions.js 的 writeProvidersConfigFile 一致。
 * 依赖以命名参数注入（默认真实 fs 与 data/ 路径），测试可传 mock / 临时路径。
 *
 * @module ai-gateway-desk/src/core/providers-config
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** src/core/ → 项目根 data/ */
function resolveData(...segments) {
  return path.resolve(__dirname, '..', '..', 'data', ...segments)
}

/** AI Gateway 默认主机（Cloudflare 统一入口） */
export const DEFAULT_GATEWAY_HOST = 'gateway.ai.cloudflare.com'
/** 默认 gateway id */
export const DEFAULT_GATEWAY_ID = 'cf-ai-gateway'
/** KV 中存放模型列表的 key */
export const DEFAULT_KV_KEY = 'models'

/**
 * 读取 data/providers.json（不存在 / 损坏时返回空对象，不抛错）
 * @param {object} [deps]
 * @param {Function} [deps.readFileSync]
 * @param {Function} [deps.existsSync]
 * @param {string} [deps.configPath]
 * @returns {object}
 */
export function readProvidersConfig(deps = {}) {
  const {
    readFileSync: read = fs.readFileSync,
    existsSync: exists = fs.existsSync,
    configPath = resolveData('providers.json'),
  } = deps
  if (!exists(configPath)) return {}
  try {
    const raw = JSON.parse(read(configPath, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * 写入 data/providers.json（覆盖）：自动补尾换行、写前备份 .bak
 * @param {object} config
 * @param {object} [deps]
 * @returns {{ backupPath: string|null }}
 */
function writeProvidersConfig(config, deps = {}) {
  const {
    readFileSync: read = fs.readFileSync,
    writeFileSync: write = fs.writeFileSync,
    existsSync: exists = fs.existsSync,
    mkdirSync: mkdir = fs.mkdirSync,
    configPath = resolveData('providers.json'),
    backupPath = resolveData('providers.json.bak'),
  } = deps
  const fileExisted = exists(configPath)
  if (fileExisted) write(backupPath, read(configPath))
  mkdir(path.dirname(configPath), { recursive: true })
  write(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { backupPath: fileExisted ? backupPath : null }
}

/**
 * 合并写入 data/providers.json 的 gateway / kv 分块
 *
 * 只覆盖传入的分块（gateway / kv），其余字段原样保留；同时补齐 loadConfig()
 * 的必需字段，保证产出的文件始终合法（全新机器 / KV 失败跳过时也能被读取）：
 *   - gateway：传入或既有则合并，host 缺失补默认主机
 *   - kv：始终保证存在（namespaceId 为字符串，key 缺省 models）
 *   - providers：始终保证为数组
 * @param {object} patch
 * @param {{ host?: string, accountId?: string, gatewayId?: string }} [patch.gateway]
 * @param {{ namespaceId?: string, key?: string }} [patch.kv]
 * @param {object} [deps] - 同 readProvidersConfig（另支持 writeFileSync / mkdirSync / backupPath）
 * @returns {{ backupPath: string|null, config: object }}
 */
export function mergeProvidersConfig({ gateway, kv } = {}, deps = {}) {
  const existing = readProvidersConfig(deps)
  const next = { ...existing }

  if (gateway || next.gateway) {
    const merged = { ...(next.gateway || {}), ...(gateway || {}) }
    if (!merged.host) merged.host = DEFAULT_GATEWAY_HOST
    next.gateway = merged
  }

  const mergedKv = { ...(next.kv || {}), ...(kv || {}) }
  if (typeof mergedKv.namespaceId !== 'string') mergedKv.namespaceId = ''
  if (!mergedKv.key) mergedKv.key = DEFAULT_KV_KEY
  next.kv = mergedKv

  if (!Array.isArray(next.providers)) next.providers = []

  const { backupPath } = writeProvidersConfig(next, deps)
  return { backupPath, config: next }
}

/**
 * 回填 data/providers.json 的 kv.namespaceId（KV 创建 / 查找成功后调用）
 * @param {string} namespaceId
 * @param {object} [deps]
 * @returns {{ backupPath: string|null, config: object }}
 */
export function backfillKVNamespaceId(namespaceId, deps = {}) {
  const existing = readProvidersConfig(deps)
  const existingKv = existing.kv && typeof existing.kv === 'object' ? existing.kv : {}
  return mergeProvidersConfig(
    { kv: { namespaceId, key: existingKv.key || DEFAULT_KV_KEY } },
    deps
  )
}
