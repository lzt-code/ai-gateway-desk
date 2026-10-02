/**
 * 管理 API Token 自检（账户页「管理 API Token」卡）
 * @module ai-gateway-desk/src/cloudflare/token-info
 *
 * 目标：在账户页回答两个问题——
 *   1. 本地保存的是哪一个令牌（名称）—— 存在多个令牌时用于定位要编辑的那一个；
 *   2. 该令牌还缺哪些所需权限 —— 直接给出「需要补充的权限」清单。
 *
 * 数据来源（与 setup 向导推荐的权限一致）：
 *   - GET /user/tokens/verify  → 当前令牌 id / status（任意有效令牌可调）
 *   - GET /user/tokens         → 令牌 name 与 policies（需 API Tokens · Read 权限）
 *
 * parsePermissionGroupName / analyzeTokenPermissions / pickTokenById 为纯函数，
 * 可独立单测（test/test-token-info.mjs）。
 */

import { verifyUserToken, listUserTokens } from './api.js'

// ─── 所需权限清单 ────────────────────────────────────────

/**
 * 本项目管理 API Token 所需的 Cloudflare 权限组。
 *
 * resource/access 用于与令牌 policies 中 permission_groups[].name 比对；
 * scope/label/reason/required 仅用于展示（required=false 表示缺失时仅提示「建议」）。
 * scope 对应 Cloudflare 创建令牌时的作用域（Account / User / Zone）；
 * label 为「<资源> · <访问级别>」，展示时与 scope 组合成「<作用域> · <资源> · <访问级别>」，
 * 名称取自 Cloudflare 权限文档（如 "Workers KV Storage Edit"）。
 *
 * reason 为面向用户的「用途说明」，统一指向界面里能感知的功能位置，
 * 便于用户判断该权限在系统中用于干嘛（账户页 / 网关页 / Provider 页等）；
 * 不再重复指明具体权限组，具体权限由 scope + label 列给出。
 * @type {ReadonlyArray<{ id: string, scope: string, resource: string, access: string, required: boolean, label: string, reason: string }>}
 */
export const REQUIRED_PERMISSIONS = Object.freeze([
  { id: 'ai-gateway-edit', scope: 'Account', resource: 'AI Gateway', access: 'Edit', required: true, label: 'AI Gateway · Edit', reason: '建 / 管 AI Gateway；在 Provider 页写入厂商 Key（BYOK）；在动态路由页管理降级链' },
  { id: 'workers-scripts-edit', scope: 'Account', resource: 'Workers Scripts', access: 'Edit', required: true, label: 'Workers Scripts · Edit', reason: '部署转发 Worker（网关页「部署 Worker」）；读取 workers.dev 默认域名与自定义域名（「Cloudflare 网关」卡）' },
  { id: 'workers-kv-edit', scope: 'Account', resource: 'Workers KV Storage', access: 'Edit', required: true, label: 'Workers KV Storage · Edit', reason: '创建 KV namespace、写入 models.json 等运行时数据（Worker 页 → 保存并提交）' },
  { id: 'api-tokens-read', scope: 'User', resource: 'API Tokens', access: 'Read', required: true, label: 'API Tokens · Read', reason: '账户页读取本令牌名称与所需权限（本卡自检依赖）' },
  { id: 'zone-read', scope: 'Zone', resource: 'Zone', access: 'Read', required: false, label: 'Zone · Read', reason: '列出账号下 Zone，供网关页「Cloudflare 网关」卡发现路由形式的自定义域名' },
  { id: 'dns-read', scope: 'Zone', resource: 'DNS', access: 'Read', required: false, label: 'DNS · Read', reason: '读取 Zone 内已代理 DNS 记录，把网关页「Cloudflare 网关」卡通配符路由（<子域>.域名）自动解析为真实子域' },
  { id: 'workers-routes-read', scope: 'Zone', resource: 'Workers Routes', access: 'Read', required: false, label: 'Workers Routes · Read', reason: '读取 Zone 下 Workers 路由，推导网关页「Cloudflare 网关」卡的自定义域名（<子域>.域名）地址' },
  { id: 'ai-gateway-run', scope: 'Account', resource: 'AI Gateway', access: 'Run', required: false, label: 'AI Gateway · Run', reason: '经 Cloudflare 网关发起推理请求（仅运行时用；本工具的管理操作不需要）' },
])

// ─── 纯函数：解析与比对 ──────────────────────────────────

/**
 * 解析 Cloudflare 权限组名 → { resource, access }
 *
 * 权限组名形如 "<资源> Read|Write|Edit|Run"（如 "Workers KV Storage Edit"）。
 * 无法识别尾部访问级别时，access 返回空串（该组不会被任何要求命中）。
 * @param {string} name
 * @returns {{ resource: string, access: string }} access 为小写
 */
export function parsePermissionGroupName(name) {
  const s = typeof name === 'string' ? name.trim() : ''
  const m = s.match(/^(.*?)[\s:]+(Read|Write|Edit|Run)$/i)
  if (!m) return { resource: s, access: '' }
  return { resource: m[1].trim(), access: m[2].toLowerCase() }
}

/**
 * 判断已授予的访问级别是否满足所需级别。
 * Cloudflare 中 Edit/Write（写）隐含读；Run 为独立能力。
 * @param {string} required - 'Read' | 'Edit' | 'Run'
 * @param {string} granted - 已授予级别（小写）
 * @returns {boolean}
 */
function accessSatisfies(required, granted) {
  const g = String(granted || '').toLowerCase()
  if (!g) return false
  const req = String(required || '').toLowerCase()
  if (req === 'run') return g === 'run'
  if (req === 'read') return g === 'read' || g === 'write' || g === 'edit'
  if (req === 'edit') return g === 'write' || g === 'edit'
  return req === g
}

/**
 * 用令牌 policies 比对所需权限清单（纯函数）
 * @param {Array<object>|null|undefined} policies - 令牌对象的 policies 数组
 * @param {ReadonlyArray<object>} [required] - 所需权限清单，默认 REQUIRED_PERMISSIONS
 * @returns {Array<object>} 逐项结果：{ ...req, granted: boolean, grantedName: string|null }
 */
export function analyzeTokenPermissions(policies, required = REQUIRED_PERMISSIONS) {
  const grantedGroups = []
  for (const policy of Array.isArray(policies) ? policies : []) {
    if (!policy || (policy.effect && policy.effect !== 'allow')) continue
    const groups = Array.isArray(policy.permission_groups) ? policy.permission_groups : []
    for (const group of groups) {
      if (group && typeof group.name === 'string' && group.name.trim()) {
        grantedGroups.push({ name: group.name.trim(), ...parsePermissionGroupName(group.name) })
      }
    }
  }
  return required.map((req) => {
    const hit = grantedGroups.find(
      (gr) => gr.resource.toLowerCase() === req.resource.toLowerCase() && accessSatisfies(req.access, gr.access)
    )
    return { ...req, granted: Boolean(hit), grantedName: hit ? hit.name : null }
  })
}

/**
 * 从令牌列表中按 id 取回当前令牌（纯函数）
 * @param {Array<object>|null|undefined} tokens
 * @param {string|null} id
 * @returns {object|null}
 */
export function pickTokenById(tokens, id) {
  if (!id || !Array.isArray(tokens)) return null
  return tokens.find((t) => t && String(t.id) === String(id)) || null
}

// ─── 编排：拉取 + 比对 ───────────────────────────────────

function errMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 构造「全部未获取」的权限清单（granted=null），用于未能读取 policies 时
 * 仍向前端提供完整表格骨架。纯函数。
 * @param {ReadonlyArray<object>} [required]
 * @returns {Array<object>}
 */
export function buildUnknownPermissions(required = REQUIRED_PERMISSIONS) {
  return required.map((req) => ({ ...req, granted: null, grantedName: null }))
}

/**
 * 构造权限清单骨架，并把「API Tokens · Read」置为已判定状态（其余保持未知）。
 *
 * 依据：
 *   - list（GET /user/tokens）成功 → 证明该权限生效 → tokenReadGranted=true
 *   - list 返回 403（权限不足）    → 证明该权限缺失 → tokenReadGranted=false
 *   - 其他错误 / 未判定            → null（前端显示「未获取」）
 * 纯函数。
 * @param {boolean|null} tokenReadGranted
 * @param {ReadonlyArray<object>} [required]
 * @returns {Array<object>}
 */
export function buildPermissionsWithTokenRead(tokenReadGranted, required = REQUIRED_PERMISSIONS) {
  return required.map((req) =>
    req.id === 'api-tokens-read'
      ? { ...req, granted: tokenReadGranted, grantedName: tokenReadGranted ? req.label : null }
      : { ...req, granted: null, grantedName: null },
  )
}

/**
 * 拉取并分析管理 API Token 的名称与权限（依赖可注入，便于单测 mock）
 *
 * 权限归属（务必分清）：
 *   - GET /user/tokens/verify → 令牌 id / 状态，**无需额外权限**（任何有效令牌可调）
 *   - GET /user/tokens        → 令牌名称 + policies（权限列表），需 **API Tokens · Read**
 *     （或 API Tokens · Write/Edit）；缺失时 Cloudflare 返回 403
 * 因此「名称 / 权限列表」的获取依赖清单中的 api-tokens-read 项。
 *
 * 返回结构（前端 buildManagementTokenInfo 消费）：
 *   { ok, configured, tokenId?, status?, name?, permissions, permissionsReadable?,
 *     error?, errorStatus? }
 *   - configured=false：未配置管理 Token
 *   - ok=false：令牌验证失败（如无效 / 网络错误）
 *   - permissions：**始终存在**，为完整所需权限清单；granted 为 true/false（可读）
 *     或 null（未能读取 policies，前端表格显示「未获取」并提示用户对照补充）
 *   - permissionsReadable=false：无法读取名称/权限（403 多为缺 API Tokens · Read）
 *   - errorStatus：list 失败的 HTTP 状态码（有则提供，便于区分 403 权限问题）
 *
 * @param {string|null} apiToken - 管理 API Token
 * @param {object} [deps]
 * @param {Function} [deps.verifyTokenFn] - 默认 verifyUserToken
 * @param {Function} [deps.listTokensFn] - 默认 listUserTokens
 * @returns {Promise<object>}
 */
export async function fetchManagementTokenInfo(apiToken, deps = {}) {
  const { verifyTokenFn = verifyUserToken, listTokensFn = listUserTokens } = deps
  if (!apiToken || !String(apiToken).trim()) {
    return { ok: true, configured: false }
  }

  let tokenId = null
  let status = null
  try {
    const verify = await verifyTokenFn(apiToken)
    tokenId = (verify && verify.id) || null
    status = (verify && verify.status) || null
  } catch (err) {
    return {
      ok: false,
      configured: true,
      error: errMessage(err),
      permissions: buildUnknownPermissions(),
      permissionsReadable: false,
    }
  }

  try {
    const tokens = await listTokensFn(apiToken)
    const token = pickTokenById(tokens, tokenId)
    if (!token) {
      // list 调用成功 → 证明 API Tokens · Read 生效；仅当前令牌未出现在首页
      return {
        ok: true,
        configured: true,
        tokenId,
        status,
        name: null,
        permissions: buildPermissionsWithTokenRead(true),
        permissionsReadable: false,
        error: '令牌列表中未找到当前令牌（可能数量超出首页）',
      }
    }
    return {
      ok: true,
      configured: true,
      tokenId,
      status,
      name: typeof token.name === 'string' && token.name.trim() ? token.name : null,
      permissions: analyzeTokenPermissions(token.policies),
      permissionsReadable: true,
    }
  } catch (err) {
    const errorStatus = typeof err?.status === 'number' ? err.status : null
    // 403 即权限不足：可确定缺失的正是 api-tokens-read；其余错误保持未知
    return {
      ok: true,
      configured: true,
      tokenId,
      status,
      name: null,
      permissions: errorStatus === 403 ? buildPermissionsWithTokenRead(false) : buildUnknownPermissions(),
      permissionsReadable: false,
      error: errMessage(err),
      errorStatus,
    }
  }
}