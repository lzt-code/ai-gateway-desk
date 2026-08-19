/**
 * Provider 列表自动拉取模块（任务 14）
 * @module ai-gateway-desk/src/cloudflare/providers-sync
 *
 * 用途：从云端自动拉取 gateway 的 provider 列表（Custom Providers + BYOK
 *       provider_configs），与本地 data/providers.json 合并同步。
 *
 * 背景：providers.json 完全靠手工维护时，用户在 dashboard 手动添加 BYOK Key
 *       或 Custom Provider 后，本地无法感知，导致 discover 漏掉新 provider。
 *       本模块供 setup 向导（任务 11）第 e 步与后续 TUI「同步 provider」入口使用。
 *
 * 依赖：./api.js（任务 10，同目录）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listCustomProviders, listProviderConfigs } from './api.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 解析到 data/ 数据目录（运行时数据的唯一存放位置）
 * src/cloudflare/ → .. = src/ → .. = 项目根 → data/
 */
function resolveData(...segments) {
  return path.resolve(__dirname, '..', '..', 'data', ...segments)
}

// ─── 云端拉取 ────────────────────────────────────────────

/**
 * 并行拉取云端 provider 列表（Custom Providers + BYOK provider_configs）
 *
 * 两个来源用 Promise.allSettled 并行，**独立失败互不中断**：
 * 某个源失败时其错误记入 errors，另一个源的结果照常返回。
 *
 * @param {string} apiToken - 管理 API Token（账户级）
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - AI Gateway id
 * @returns {Promise<{ providers: Array<object>, errors: Array<object> }>}
 *   providers 每项统一结构：{ id, name, type: 'custom-provider'|'byok', enabled }
 *   errors 每项：{ source: 'custom-providers'|'provider_configs', error: Error }
 */
export async function fetchCloudProviders(apiToken, accountId, gatewayId) {
  const [customResult, byokResult] = await Promise.allSettled([
    listCustomProviders(apiToken, accountId),
    listProviderConfigs(apiToken, accountId, gatewayId),
  ])

  const providers = []
  const errors = []
  const byId = new Map() // id → provider，同 id 冲突时 custom-provider 优先

  // 追加 provider：同 id 时保留 custom-provider（显式创建、名称信息更完整），
  // 丢弃 byok —— 否则同一 slug 会重复出现，F4 同步时 discover 会对同一 URL 发
  // 两次请求，且 mergeProviders 按 Map 去重会把 custom 条目覆盖丢失。
  const pushUnique = (p) => {
    const existing = byId.get(p.id)
    if (!existing || (existing.type !== 'custom-provider' && p.type === 'custom-provider')) {
      byId.set(p.id, p)
    }
  }

  // Custom Providers → { id: slug, cloudId, name, type: 'custom-provider', enabled: enable !== false }
  // cloudId = API 返回的 UUID（id 字段）：云端删除 / 更新端点需要 UUID 而非 slug，
  // 供 Provider 视图「d 删除（云端+本地）」直接使用
  // base_url = 上游 base URL（snake_case，来自云端）：供编辑表单预填显示
  if (customResult.status === 'fulfilled') {
    const items = Array.isArray(customResult.value) ? customResult.value : []
    for (const item of items) {
      pushUnique({
        id: item.slug,
        cloudId: item.id,
        name: item.name,
        type: 'custom-provider',
        enabled: item.enable !== false,
        base_url: item.base_url,
      })
    }
  } else {
    errors.push({ source: 'custom-providers', error: customResult.reason })
  }

  // BYOK provider_configs → { id: provider_slug, cloudId, name: alias ?? slug, type: 'byok', enabled: true }
  // cloudId = provider_config 的 UUID（id 字段）：实测 DELETE /provider_configs/{slug}
  // 返回 404（错误码 7002），必须用 UUID id 删除——与 custom-provider 同理
  if (byokResult.status === 'fulfilled') {
    const items = Array.isArray(byokResult.value) ? byokResult.value : []
    for (const item of items) {
      pushUnique({
        id: item.provider_slug,
        cloudId: item.id,
        // Cloudflare 返回 alias: "default" 作为「未设置别名」的哨兵值，
        // 此时用 provider_slug 作为显示名称，避免侧栏/列表显示无意义的 "default"
        name: (item.alias && item.alias !== 'default') ? item.alias : item.provider_slug,
        type: 'byok',
        enabled: true,
      })
    }
  } else {
    errors.push({ source: 'provider_configs', error: byokResult.reason })
  }

  providers.push(...byId.values())
  return { providers, errors }
}

// ─── 本地合并 ────────────────────────────────────────────

/**
 * 合并本地与云端 provider 列表（策略 A：provider 覆盖，参照 pipeline/merge.js）
 *
 * a. 云端有、本地没有 → 追加（enabled: true），id 记入 newProviders
 * b. 两边都有（按 id 匹配）→ 保留本地 enabled 设置，用云端 name 覆盖
 * c. 本地有、云端没有 → **保留本地条目**（不自动删除，防误删手工配置），
 *    id 记入 removedProviders 供调用方提示
 *
 * 不修改入参，返回全新数组。
 *
 * @param {Array<object>} localProviders - 本地 providers.json 的 providers 数组
 * @param {Array<object>} cloudProviders - fetchCloudProviders 返回的 providers 数组
 * @returns {{ providers: Array<object>, newProviders: string[], removedProviders: string[] }}
 */
export function mergeProviders(localProviders, cloudProviders) {
  const local = Array.isArray(localProviders) ? localProviders : []
  const cloud = Array.isArray(cloudProviders) ? cloudProviders : []

  const localById = new Map(local.map((p) => [p.id, p]))
  const cloudById = new Map(cloud.map((p) => [p.id, p]))

  const providers = []
  const newProviders = []
  const removedProviders = []

  // a / b：先处理云端条目（顺序：新增在前、覆盖在后，按云端顺序）
  for (const cloudItem of cloud) {
    const localItem = localById.get(cloudItem.id)
    if (localItem) {
      // b. 两边都有 → 保留本地 enabled（缺失时回退云端），用云端 name 覆盖，type 取云端
      providers.push({
        ...cloudItem,
        name: cloudItem.name ?? localItem.name,
        enabled: localItem.enabled ?? cloudItem.enabled,
        pathPrefix: localItem.pathPrefix,
      })
    } else {
      // a. 云端有、本地没有 → 追加
      providers.push({ ...cloudItem, enabled: cloudItem.enabled !== false })
      newProviders.push(cloudItem.id)
    }
  }

  // c. 本地有、云端没有 → 保留本地条目，提示可能已从云端删除
  for (const localItem of local) {
    if (!cloudById.has(localItem.id)) {
      providers.push({ ...localItem })
      removedProviders.push(localItem.id)
    }
  }

  return { providers, newProviders, removedProviders }
}

// ─── 同步入口 ────────────────────────────────────────────

/**
 * 同步云端 provider 列表到本地 data/providers.json
 *
 * 与 loadConfig 的区别：**直接读文件 + JSON.parse**。因为同步可能发生在
 * setup 之前的全新环境（文件不存在 / 校验失败），此时应视为「本地无 provider」
 * 继续同步，而不是抛错中断。
 *
 * 写回策略：
 * - 仅替换 providers 数组，gateway / kv 等其余字段原样保留
 * - 文件不存在时写入仅含 providers 数组的最小结构（{ providers: [...] }），
 *   并提示用户补全 gateway / kv
 * - 写回前自动备份原文件为 providers.json.bak（原文件不存在时跳过备份）
 *
 * @param {object} config - 需含 gateway.accountId / gateway.gatewayId（可部分缺失）
 * @param {string} apiToken - 管理 API Token（账户级）
 * @returns {Promise<{ providers: Array<object>, newProviders: string[], removedProviders: string[], backupPath: string|null, errors: Array<object> }>}
 */
export async function syncProviders(config, apiToken) {
  const { accountId, gatewayId } = config?.gateway ?? {}

  const configPath = resolveData('providers.json')
  const backupPath = resolveData('providers.json.bak')
  const fileExisted = existsSync(configPath)

  // 1. 读取本地（文件不存在 / 解析失败 → 视为空配置继续）
  let localConfig = { providers: [] }
  if (fileExisted) {
    try {
      localConfig = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
      localConfig = { providers: [] }
    }
  }
  const localProviders = Array.isArray(localConfig.providers) ? localConfig.providers : []

  // 2. 拉取云端 + 合并
  const { providers: cloudProviders, errors } = await fetchCloudProviders(
    apiToken, accountId, gatewayId
  )
  const merged = mergeProviders(localProviders, cloudProviders)

  // 云端拉取不完整（有源失败）时，removed 判断不可靠：
  // 「本地有、云端没有」可能只是该源没拉到，而不是真的被删除，不提示
  const removedProviders = errors.length > 0 ? [] : merged.removedProviders

  // 3. 写回（写前备份原文件）
  let backup = null
  if (fileExisted) {
    backup = backupPath
    writeFileSync(backupPath, readFileSync(configPath))
  }
  const newConfig = { ...localConfig, providers: merged.providers }
  writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n')

  // 全新环境（原文件不存在）：写入的最小结构缺 gateway/kv，下次 loadConfig 会失败
  if (!fileExisted) {
    console.warn('[providers-sync] data/providers.json 为最小结构，请补全 gateway / kv 字段')
  }

  return {
    providers: merged.providers,
    newProviders: merged.newProviders,
    removedProviders,
    backupPath: backup,
    errors,
  }
}
