/**
 * Provider 管理视图纯逻辑（任务 20）
 * @module ai-gateway-desk/src/tui/provider-actions
 *
 * Provider 管理视图纯逻辑
 *
 * 背景：**云端唯一真相，本地缓存降级**——本地 providers.json 仅作 discover
 * 工作输入 + 缓存降级。Provider 视图进入时拉取云端 provider 列表
 * （fetchCloudProviders）与本地合并展示：
 *   - 云端新增（本地无）→ 标 `{新增}`（enabled 默认 true）
 *   - 云端已删（本地有）→ 标 `{云端已删}` + 删除时仅移除本地（云端已无）
 *   - 两边都有 → 显示云端 name，保留本地 enabled
 *   - 拉取失败 / 未配置管理 Token → 只读模式，展示本地缓存 + 顶栏警告
 *
 * 编辑规则（已确认约束，写死在实现中）：
 *   - name：Custom Provider 可改（PATCH name）；BYOK 改名必须同时提供新 Key
 *     （PUT 端点 secret 必填，云端不回传 secret，单独改名会清空 Key）
 *   - apiKey：仅 BYOK 支持覆盖（PUT secret）；Custom Provider 的认证在
 *     base_url / headers 中，无独立 Key 字段，不支持
 *   - 可见性（enabled / "隐藏"）：**纯本地状态并同步到 KV**（provider-visibility
 *     键），跨 PC 一致；隐藏后不同步其模型、模型页不展示该 provider 及其模型。
 *     不再管控云端 enable 字段（云端配置不在本工具切换）。
 *   - 删除（d）：**云端 + 本地同步删除**——Custom Provider 调 DELETE
 *     /custom-providers/{cloudId}（cloudId 为 fetchCloudProviders 携带的 UUID），
 *     BYOK 调 DELETE /provider_configs/{slug}；成功后本地 providers.json 移除。
 *     云端已删（[云端已删] 标记）条目仅删本地。
 *   - 离线降级：只读模式（无可控字段，可见性也需写 KV）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createCustomProvider, createProviderConfig, updateCustomProvider, updateProviderConfig, deleteCustomProvider, deleteProviderConfig } from '../cloudflare/api.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** src/tui/ → 项目根 data/ */
function resolveData(...segments) {
  return path.resolve(__dirname, '..', '..', 'data', ...segments)
}

// ─── 合并展示 ────────────────────────────────────────────

/**
 * 合并云端与本地 provider 列表为展示数组（纯函数，不修改入参）
 *
 * @param {Array<object>} localProviders - 本地 providers.json 的 providers 数组
 * @param {{ providers: Array<object>, errors: Array<object> }|null} cloudResult -
 *   fetchCloudProviders 返回；null 表示拉取失败 / 未配置管理 Token（只读降级）
 * @returns {{ providers: Array<{ id, name, type, enabled, mark }>, readonly: boolean }}
 *   mark: 'new'（云端新增）/ 'removed'（本地独有，云端已删）/ null（两边都有或缓存）
 *   readonly: true 表示只读降级（拉取失败 / 无管理 Token）
 */
export function mergeProviderViews(localProviders, cloudResult) {
  const local = Array.isArray(localProviders) ? localProviders : []

  // 拉取失败 / 未配置 Token：只读降级，展示本地缓存（mark 全部 null）
  if (!cloudResult || !Array.isArray(cloudResult.providers)) {
    return {
      providers: local.map((p) => ({ ...p, mark: null })),
      readonly: true,
    }
  }

  const cloud = cloudResult.providers
  // 云端拉取不完整（任一源失败）时 removed 判断不可靠：不标 {云端已删}（复用任务 14 抑制逻辑）
  const cloudIncomplete = Array.isArray(cloudResult.errors) && cloudResult.errors.length > 0

  const localById = new Map(local.map((p) => [p.id, p]))
  const cloudById = new Map(cloud.map((p) => [p.id, p]))

  const merged = []
  // a / b：云端条目（新增在前、覆盖在后，按云端顺序）
  for (const cloudItem of cloud) {
    const localItem = localById.get(cloudItem.id)
    if (localItem) {
      // b. 两边都有 → 以本地为基底保留本地独有字段（如 pathPrefix），云端覆盖
      merged.push({
        ...localItem,
        ...cloudItem,
        name: cloudItem.name ?? localItem.name,
        enabled: localItem.enabled ?? cloudItem.enabled,
        mark: null,
      })
    } else {
      // a. 云端有、本地没有 → 追加并标记 {新增}
      merged.push({ ...cloudItem, enabled: cloudItem.enabled !== false, mark: 'new' })
    }
  }
  // c. 本地有、云端没有（拉取完整时）→ 保留本地条目并标记 {云端已删}
  //    （删除该条目时仅移除本地，云端已无）
  if (!cloudIncomplete) {
    for (const localItem of local) {
      if (!cloudById.has(localItem.id)) {
        merged.push({ ...localItem, mark: 'removed' })
      }
    }
  }

  return { providers: merged, readonly: false }
}

// ─── 本地操作（纯函数，返回新数组，不修改入参） ───────────

/**
 * 本地移除：从本地 providers 数组中移除指定 id 的条目（删除流程的最后一步；
 * 云端删除由 deleteProviderCloud 负责，[云端已删] 条目仅本地移除）
 * @param {Array<object>} localProviders
 * @param {string} id
 * @returns {Array<object>} 移除后的新数组
 */
export function followDelete(localProviders, id) {
  return localProviders.filter((p) => p.id !== id)
}

/**
 * 更新本地可见性开关（enabled = 是否显示/参与发现，对应 UI「隐藏」的反义）
 * @param {Array<object>} localProviders
 * @param {string} id
 * @param {boolean} enabled
 * @returns {Array<object>} 更新后的新数组
 */
export function setLocalEnabled(localProviders, id, enabled) {
  return localProviders.map((p) => (p.id === id ? { ...p, enabled } : p))
}

/**
 * 将 KV 中的可见性映射应用到 provider 列表（纯函数，不修改入参）。
 *
 * KV 是跨 PC 的可见性真相源：visibilityMap[id] === false → 隐藏（enabled=false），
 * 其余（true / 缺省）→ 显示。本地 providers.json 的 enabled 仅作缓存与离线降级，
 * 由本函数在加载时以 KV 为准覆盖。
 *
 * @param {Array<object>} providers
 * @param {Record<string, boolean>} visibilityMap - KV provider-visibility 内容
 * @returns {Array<object>} 应用可见性后的新数组
 */
export function applyVisibility(providers, visibilityMap) {
  const map = visibilityMap && typeof visibilityMap === 'object' ? visibilityMap : {}
  return (Array.isArray(providers) ? providers : []).map((p) => {
    if (!p || !p.id || !(p.id in map)) return p
    const enabled = map[p.id] !== false
    return p.enabled === enabled ? p : { ...p, enabled }
  })
}

/**
 * 从 provider 列表提取可见性映射（id → enabled），供写入 KV。
 * @param {Array<object>} providers
 * @returns {Record<string, boolean>}
 */
export function buildVisibilityMap(providers) {
  const map = {}
  for (const p of Array.isArray(providers) ? providers : []) {
    if (p && p.id) map[p.id] = p.enabled !== false
  }
  return map
}

/**
 * 云端改名 / 覆盖 Key 成功后同步本地 name（保持展示一致）
 * @param {Array<object>} localProviders
 * @param {string} id
 * @param {string} name
 * @returns {Array<object>} 更新后的新数组
 */
export function setLocalName(localProviders, id, name) {
  return localProviders.map((p) => (p.id === id ? { ...p, name } : p))
}

/**
 * 云端改 base_url 成功后同步本地 base_url（保持编辑表单预填一致）
 * @param {Array<object>} localProviders
 * @param {string} id
 * @param {string} baseUrl
 * @returns {Array<object>} 新数组（不修改入参）
 */
export function setLocalBaseUrl(localProviders, id, baseUrl) {
  return localProviders.map((p) => (p.id === id ? { ...p, base_url: baseUrl } : p))
}

// ─── 编辑结果组装 ────────────────────────────────────────

/**
 * 组装云端更新参数（纯函数）
 *
 * changes 各字段为 null 表示未修改。返回：
 *   { ok: true, params }            → 可直接调用对应云端函数
 *   { ok: false, unsupported: str } → 云端不支持该变更（给出提示文案）
 *
 * 实测 API 能力（2026-08-19 实测修正，路径参数与删除端点同理）：
 *   - 两类端点的更新路径均要求 UUID（provider.cloudId）而非 slug——
 *     PATCH /custom-providers/{slug}、PUT /provider_configs/{slug} 均返回
 *     7001 "Invalid uuid"。缺 cloudId（本地缓存/旧数据）→ unsupported 提示刷新。
 *   - Custom Provider：PATCH 可改 name；api key 覆盖 = headers.Authorization
 *   - BYOK：PUT 需 **secret 必填**（缺 secret 400），云端不回传完整 secret →
 *     单独改名不支持；覆盖 Key = 以新 secret PUT（可同时改名）
 *
 * 注：云端 enable 字段不再由本工具管控（可见性由本地 + KV provider-visibility
 * 决定，不切换网关侧启用状态）。
 *
 * @param {{ id: string, name: string, type: string, cloudId?: string }} provider
 * @param {{ name: string|null, apiKey: string|null }} changes
 * @returns {{ ok: boolean, params?: object, unsupported?: string }}
 */
export function buildCloudUpdateParams(provider, changes = {}) {
  const { name, apiKey, baseUrl } = changes

  if (provider.type === 'custom-provider') {
    if (!name && !apiKey && !baseUrl) {
      return { ok: false, unsupported: '无云端变更' }
    }
    // 云端更新端点（PATCH/PUT）均要求 UUID（cloudId）而非 slug：
    // 实测 2026-08-19 传 slug 返回 7001 "Invalid uuid"（与删除端点同理）。
    if (!provider.cloudId) {
      return { ok: false, unsupported: '缺少云端 ID（cloudId），请先刷新拉取云端列表' }
    }
    const body = {}
    if (name) body.name = name
    if (apiKey) body.headers = { Authorization: `Bearer ${apiKey}` }
    // baseUrl 透传给 updateCustomProvider（其内部映射为 base_url，PATCH 可改）
    if (baseUrl) body.baseUrl = baseUrl
    return { ok: true, params: { kind: 'custom-provider', id: provider.cloudId, body } }
  }

  // BYOK
  if (baseUrl) {
    return { ok: false, unsupported: 'BYOK 不支持修改 Base URL（官方厂商路径固定）' }
  }
  if (name && !apiKey) {
    return { ok: false, unsupported: 'BYOK 改名需要同时提供新 Key（PUT 端点 secret 必填）' }
  }
  if (!apiKey) {
    return { ok: false, unsupported: '无云端变更' }
  }
  if (!provider.cloudId) {
    return { ok: false, unsupported: '缺少云端 ID（cloudId），请先刷新拉取云端列表' }
  }
  return {
    ok: true,
    params: {
      kind: 'byok',
      id: provider.cloudId,
      // slug 仅作 PUT body 的 provider_slug 字段（路径要求 UUID，7001）
      slug: provider.id,
      body: { secret: apiKey, ...(name ? { alias: name } : {}) },
    },
  }
}

// ─── 云端更新编排 ────────────────────────────────────────

/**
 * 按 provider 类型调用对应的云端更新函数
 *
 * 依赖以命名参数注入（默认绑定真实 api.js），测试可传 mock。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {{ id: string, type: string }} provider
 * @param {object} changes - 同 buildCloudUpdateParams
 * @param {object} [deps]
 * @param {Function} [deps.updateCustomFn] - 默认 updateCustomProvider
 * @param {Function} [deps.updateConfigFn] - 默认 updateProviderConfig
 * @returns {Promise<{ ok: boolean, result?: object, error?: Error, unsupported?: string }>}
 */
export async function updateProviderCloud(apiToken, accountId, gatewayId, provider, changes, deps = {}) {
  const {
    updateCustomFn = updateCustomProvider,
    updateConfigFn = updateProviderConfig,
  } = deps

  const built = buildCloudUpdateParams(provider, changes)
  if (!built.ok) return built

  try {
    const { kind, id, slug, body } = built.params
    const result = kind === 'custom-provider'
      ? await updateCustomFn(apiToken, accountId, id, body)
      // PUT 路径用 UUID（cloudId = id）；slug 仅作 body 的 provider_slug
      : await updateConfigFn(apiToken, accountId, gatewayId, id, { ...body, providerSlug: slug })
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error }
  }
}

// ─── 云端创建编排 ────────────────────────────────────────

/**
 * 组装云端创建参数（纯函数）
 *
 * draft = { type, id, name?, apiKey?, baseUrl?, pathPrefix? }。
 * 校验规则：
 *   - type 必须是 'byok' 或 'custom-provider'
 *   - id（slug）须匹配 /^[a-z0-9][a-z0-9-]{0,62}$/
 *   - name 选填非空字符串（trim 后为空视为未填，缺省取 slug）
 *   - byok：apiKey 必填（→ 云端 secret）；baseUrl / pathPrefix 为非法组合
 *   - custom-provider：baseUrl 必填且以 http:// 或 https:// 开头；
 *     apiKey 选填（非空 → headers: { Authorization: 'Bearer <key>' }）
 * 失败返回 { ok: false, reason: '<中文可读原因>' }，成功返回
 * { ok: true, slug, name, type, secret?, baseUrl?, headers? }。
 *
 * @param {{ type: string, id: string, name?: string, apiKey?: string, baseUrl?: string, pathPrefix?: string }} draft
 * @returns {{ ok: boolean, slug?: string, name?: string, type?: string, secret?: string, baseUrl?: string, headers?: object, reason?: string }}
 */
export function buildCloudCreateParams(draft = {}) {
  const { type, id, name, apiKey, baseUrl, pathPrefix } = draft

  if (type !== 'byok' && type !== 'custom-provider') {
    return { ok: false, reason: '类型必须是 byok 或 custom-provider' }
  }
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    return { ok: false, reason: 'slug 须以小写字母或数字开头，仅含小写字母、数字与连字符，最长 63 字符' }
  }
  const nameValue = typeof name === 'string' && name.trim() !== '' ? name.trim() : id

  if (type === 'byok') {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      return { ok: false, reason: 'BYOK 必须提供 apiKey（厂商 Key）' }
    }
    if (
      (typeof baseUrl === 'string' && baseUrl.trim() !== '') ||
      (typeof pathPrefix === 'string' && pathPrefix.trim() !== '')
    ) {
      return { ok: false, reason: 'BYOK 创建不支持 baseUrl / pathPrefix' }
    }
    return { ok: true, slug: id, name: nameValue, type, secret: apiKey }
  }

  // custom-provider
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    return { ok: false, reason: 'Custom Provider 必须提供 baseUrl（http:// 或 https:// 开头）' }
  }
  const result = { ok: true, slug: id, name: nameValue, type, baseUrl }
  if (typeof apiKey === 'string' && apiKey.trim() !== '') {
    result.headers = { Authorization: `Bearer ${apiKey.trim()}` }
  }
  return result
}

/**
 * 创建 provider 的云端配置（Custom Provider / BYOK）
 *
 * 依赖以命名参数注入（默认绑定真实 api.js），测试可传 mock。
 * 成功返回的 entry 即本地落盘条目：cloudId 取云端返回的 UUID（删除功能依赖），
 * 云端未返回 id 时 cloudId 为 undefined，不兜底。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {{ type: string, id: string, name?: string, apiKey?: string, baseUrl?: string, pathPrefix?: string }} draft
 * @param {object} [deps]
 * @param {Function} [deps.createConfigFn] - 默认 createProviderConfig（BYOK）
 * @param {Function} [deps.createCustomFn] - 默认 createCustomProvider（Custom）
 * @returns {Promise<{ ok: boolean, entry?: object, reason?: string, error?: Error }>}
 *   ok=false 且 reason 存在 → 参数校验失败（未触网）；error 存在 → 云端调用失败
 */
export async function createProviderCloud(apiToken, accountId, gatewayId, draft, deps = {}) {
  const {
    createConfigFn = createProviderConfig,
    createCustomFn = createCustomProvider,
  } = deps

  const built = buildCloudCreateParams(draft)
  if (!built.ok) return built

  try {
    const { slug, name, type, secret, baseUrl, headers } = built
    const result = type === 'byok'
      ? await createConfigFn(apiToken, accountId, gatewayId, { providerSlug: slug, secret, alias: name })
      : await createCustomFn(apiToken, accountId, {
          name,
          slug,
          baseUrl,
          enable: true,
          ...(headers ? { headers } : {}),
        })
    return {
      ok: true,
      entry: {
        id: slug,
        name,
        type,
        enabled: true,
        cloudId: result?.id,
        // custom provider：同步 base_url 到本地条目，编辑表单可预填展示；
        // byok 无该字段（官方路径固定）
        ...(type === 'custom-provider' ? { base_url: baseUrl } : {}),
      },
    }
  } catch (error) {
    return { ok: false, error }
  }
}

// ─── 云端删除编排 ────────────────────────────────────────

/**
 * 组装云端删除参数（纯函数）
 *
 * 删除目标判定（2026-08-09 实测修正：两者 DELETE 端点均需 UUID 而非 slug）：
 *   - custom-provider → DELETE /custom-providers/{cloudId}（cloudId = fetchCloudProviders
 *     携带的 UUID）
 *   - byok → DELETE /provider_configs/{cloudId}（provider_config 的 UUID id；
 *     实测 DELETE /provider_configs/{slug} 返回 404 错误码 7002）
 *   - cloudId 缺失（列表来自本地缓存/旧数据）→ 提示先按 r 刷新拉取云端
 *
 * @param {{ id: string, type: string, cloudId?: string }} provider
 * @returns {{ ok: true, params: { kind: 'custom-provider'|'byok', id: string } }|{ ok: false, reason: string }}
 */
export function buildCloudDeleteParams(provider) {
  if (!provider?.cloudId) {
    return { ok: false, reason: '缺少云端 ID（cloudId），请先按 r 刷新拉取云端列表' }
  }
  const kind = provider.type === 'custom-provider' ? 'custom-provider' : 'byok'
  return { ok: true, params: { kind, id: provider.cloudId } }
}

/**
 * 删除 provider 的云端配置（Custom Provider / BYOK）
 *
 * 依赖以命名参数注入（默认绑定真实 api.js），测试可传 mock。
 * 仅负责云端；本地移除由调用方（index.js followDelete + 写回）负责。
 *
 * @param {string} apiToken - 管理 API Token
 * @param {string} accountId - Cloudflare 账户 ID
 * @param {string} gatewayId - gateway id
 * @param {{ id: string, type: string, cloudId?: string }} provider
 * @param {object} [deps]
 * @param {Function} [deps.deleteCustomFn] - 默认 deleteCustomProvider
 * @param {Function} [deps.deleteConfigFn] - 默认 deleteProviderConfig
 * @returns {Promise<{ ok: boolean, result?: object, error?: Error, reason?: string }>}
 *   ok=false 且 reason 存在 → 参数不完整（未触网）；error 存在 → 云端调用失败
 */
export async function deleteProviderCloud(apiToken, accountId, gatewayId, provider, deps = {}) {
  const {
    deleteCustomFn = deleteCustomProvider,
    deleteConfigFn = deleteProviderConfig,
  } = deps

  const built = buildCloudDeleteParams(provider)
  if (!built.ok) return built

  try {
    const { kind, id } = built.params
    const result = kind === 'custom-provider'
      ? await deleteCustomFn(apiToken, accountId, id)
      : await deleteConfigFn(apiToken, accountId, gatewayId, id)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error }
  }
}

// ─── 写回本地 providers.json ─────────────────────────────

/**
 * 写回本地 providers 数组（编辑 / 删除（云端成功后本地移除）/ 本地开关后同步）
 *
 * 与 syncProviders 相同的写回模式：仅替换 providers 数组，gateway / kv 等
 * 其余字段原样保留；写前自动备份原文件为 providers.json.bak。
 * 依赖以命名参数注入（默认真实 fs 与 data/ 路径），测试可传 mock / 临时目录。
 *
 * @param {Array<object>} providers
 * @param {object} [deps]
 * @returns {{ backupPath: string|null }} 备份路径（原文件不存在时 null）
 */
export function writeProvidersConfigFile(providers, deps = {}) {
  const {
    readFileSync: read = readFileSync,
    writeFileSync: write = writeFileSync,
    existsSync: exists = existsSync,
    configPath = resolveData('providers.json'),
    backupPath = resolveData('providers.json.bak'),
  } = deps

  const fileExisted = exists(configPath)
  let localConfig = { providers: [] }
  if (fileExisted) {
    try {
      localConfig = JSON.parse(read(configPath, 'utf-8'))
    } catch {
      localConfig = { providers: [] }
    }
  }
  if (fileExisted) {
    write(backupPath, read(configPath))
  }
  write(configPath, JSON.stringify({ ...localConfig, providers }, null, 2) + '\n')
  return { backupPath: fileExisted ? backupPath : null }
}
