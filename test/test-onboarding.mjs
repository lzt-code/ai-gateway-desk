/**
 * Web 初始化引导（onboarding）逻辑层测试
 *
 * 覆盖：
 *   - isInitialized：无 / 本地 / env 管理 Token 的判定
 *   - discoverOnboarding：解析账户 + 列网关（成功 / 多账户选择 / 无账户 / 失败）
 *   - completeOnboarding：确认网关 → 验证 cfut → 保存 → KV → 写配置
 *     （成功 / 网关失败 / cfut 失败不落盘 / 缺参 / KV 复用 / KV 失败降级）
 *   - core/providers-config 纯文件读写（合并保留其余字段 / 回填 / 损坏容错）
 *   - createGateway 请求体（回归 Cloudflare 7001：必需数值字段不得缺省）
 *   - createGateway 幂等（409 / 400 7001 "already exists" → 取回现有网关）
 *   - verifyGatewayToken：区分认证失败（401）与网络不可达；非认证类 400（如 2008 Invalid
 *     provider，认证已放行）判为令牌有效；verifyFailureHint 分类提示
 *   - 前端纯函数：isOnboardingNeeded / gatewayChoices / requiredPermissionLines / failureStatusLines
 *
 * 全程依赖注入 mock，零触网零真实写盘（providers-config 用临时目录）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isInitialized, discoverOnboarding, completeOnboarding, verifyFailureHint, KV_NAMESPACE_TITLE } from '../src/logic/onboarding.js'
import { createGateway, verifyGatewayToken } from '../src/cloudflare/api.js'
import {
  readProvidersConfig,
  mergeProvidersConfig,
  backfillKVNamespaceId,
} from '../src/core/providers-config.js'
import {
  isOnboardingNeeded,
  gatewayChoices,
  requiredPermissionLines,
  failureStatusLines,
  DEFAULT_GATEWAY_ID,
} from '../src/web/public/onboarding.js'

let failures = 0
let checks = 0
function check(cond, msg) {
  checks++
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}`) }
}
function section(name) { console.log(`\n${name}`) }

// ── isInitialized ────────────────────────────────────────

section('isInitialized')
{
  check(isInitialized({}) === false, '空 → false')
  check(isInitialized({ localManagement: 'mgt' }) === true, '本地管理 Token → true')
  check(isInitialized({ envManagement: 'env-token' }) === true, 'env 管理 Token → true')
  check(isInitialized({ envManagement: '   ' }) === false, '空白 env → false')
  check(isInitialized({ localManagement: null, envManagement: null }) === false, 'null → false')
}

// ── discoverOnboarding ───────────────────────────────────

section('discoverOnboarding')
{
  const accounts = [{ id: 'acc-1', name: 'One' }, { id: 'acc-2', name: 'Two' }]
  const gateways = [{ id: 'gw-a' }, { id: 'gw-b' }]
  const calls = []
  const deps = {
    listAccountsFn: async (t) => { calls.push(['accounts', t]); return accounts },
    listGatewaysFn: async (t, a) => { calls.push(['gateways', t, a]); return gateways },
  }

  const r = await discoverOnboarding({ managementToken: 'tok' }, deps)
  check(r.ok === true, '成功返回 ok')
  check(r.accountId === 'acc-1', '缺省取第一个账户')
  check(r.gateways.length === 2, '返回网关列表')
  check(calls[0][1] === 'tok', 'listAccounts 收到 token')

  const r2 = await discoverOnboarding({ managementToken: 'tok', accountId: 'acc-2' }, deps)
  check(r2.accountId === 'acc-2', '多账户时按用户选择')

  const r3 = await discoverOnboarding({ managementToken: '' }, deps)
  check(r3.ok === false && r3.error.includes('管理 API Token'), '空 token → 报错')

  const r4 = await discoverOnboarding({ managementToken: 'tok' }, {
    listAccountsFn: async () => [],
    listGatewaysFn: async () => [],
  })
  check(r4.ok === false && r4.accounts.length === 0, '无账户 → ok:false + accounts:[]')

  const r5 = await discoverOnboarding({ managementToken: 'tok' }, {
    listAccountsFn: async () => { throw new Error('401 Unauthorized') },
    listGatewaysFn: async () => [],
  })
  check(r5.ok === false && r5.error.includes('401'), '令牌无效 → 透传错误')
}

// ── completeOnboarding ───────────────────────────────────

section('completeOnboarding')
{
  function makeDeps(overrides = {}) {
    const calls = []
    const deps = {
      calls,
      createGatewayFn: async (t, a, g) => { calls.push(['createGateway', a, g]); return { id: g } },
      verifyGatewayTokenFn: async (h, a, g, tok) => { calls.push(['verify', a, g, tok]); return true },
      writeManagementFn: (t) => calls.push(['writeMgmt', t]),
      writeGatewayFn: (t) => calls.push(['writeGw', t]),
      listKVNamespacesFn: async (t, a) => { calls.push(['listKv', a]); return [{ id: 'kv-1', title: KV_NAMESPACE_TITLE }] },
      createKVNamespaceFn: async (t, a, title) => { calls.push(['createKv', a, title]); return { id: 'kv-new', title } },
      mergeProvidersConfigFn: (patch) => { calls.push(['merge', patch]); return { config: {} } },
      ...overrides,
    }
    return deps
  }

  // 成功：复用既有 KV
  {
    const deps = makeDeps()
    const r = await completeOnboarding({
      managementToken: 'mgt', accountId: 'acc', gatewayId: 'gw', gatewayToken: 'cfut_x',
    }, deps)
    check(r.ok === true, '成功 ok:true')
    check(r.gatewayId === 'gw', '返回 gatewayId')
    check(r.kvNamespaceId === 'kv-1', '复用既有 KV id')
    const kw = deps.calls.find((c) => c[0] === 'createKv')
    check(!kw, '既有 KV 时不重复创建')
    const merge = deps.calls.find((c) => c[0] === 'merge')
    check(merge[1].gateway.accountId === 'acc' && merge[1].gateway.gatewayId === 'gw', '写回 gateway')
    check(merge[1].kv.namespaceId === 'kv-1', '写回 kv.namespaceId')
    check(deps.calls.some((c) => c[0] === 'writeMgmt' && c[1] === 'mgt'), '保存管理 Token')
    check(deps.calls.some((c) => c[0] === 'writeGw' && c[1] === 'cfut_x'), '保存 Gateway Token')
  }

  // 缺 cfut → 直接报错，不创建网关
  {
    const deps = makeDeps()
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: '' }, deps)
    check(r.ok === false && r.error.includes('cfut_xxx'), '缺 cfut → 报错')
    check(!deps.calls.some((c) => c[0] === 'createGateway'), '缺参不创建网关')
  }

  // 网关创建失败 → ok:false，不验证不落盘
  {
    const deps = makeDeps({ createGatewayFn: async () => { throw new Error('403 Forbidden') } })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'cfut_x' }, deps)
    check(r.ok === false && r.error.includes('创建/确认 Gateway 失败'), '网关失败 → 报错')
    check(!deps.calls.some((c) => c[0] === 'verify'), '网关失败不验证 cfut')
    check(!deps.calls.some((c) => c[0] === 'writeMgmt'), '网关失败不落盘')
  }

  // cfut 验证失败 → 不落盘（避免半成品）
  {
    const deps = makeDeps({ verifyGatewayTokenFn: async () => false })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'bad' }, deps)
    check(r.ok === false && r.error.includes('Gateway Token 验证失败'), '验证失败 → 报错')
    check(!deps.calls.some((c) => c[0] === 'writeMgmt'), '验证失败不落盘')
  }

  // cfut 401（结构化返回）→ 明示「未通过认证」而非笼统失败
  {
    const deps = makeDeps({
      verifyGatewayTokenFn: async () => ({ ok: false, status: 401, detail: 'HTTP 401 Unauthorized（2009 Unauthorized）' }),
    })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayId: 'gw', gatewayToken: 'bad' }, deps)
    check(r.ok === false && r.error.includes('401'), '401 → 错误含状态码')
    check(r.error.includes('Authentication') && r.error.includes('gateway=gw'), '401 → 提示绑定/认证 + 目标网关')
    check(!deps.calls.some((c) => c[0] === 'writeMgmt'), '401 不落盘')
  }

  // cfut 网络不可达（结构化返回）→ 提示为网络问题，不误导成令牌错误
  {
    const deps = makeDeps({
      verifyGatewayTokenFn: async () => ({ ok: false, status: null, detail: 'fetch failed（UND_ERR_CONNECT_TIMEOUT @ gateway.ai.cloudflare.com）' }),
    })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'x' }, deps)
    check(r.ok === false && r.error.includes('无法连接'), '网络失败 → 提示为「无法连接」')
    check(r.error.includes('UND_ERR_CONNECT_TIMEOUT'), '网络失败 → 保留根因')
  }

  // cfut 400「Invalid provider」（非认证类响应，认证已放行）→ 视为通过并继续初始化
  {
    const deps = makeDeps({
      verifyGatewayTokenFn: async () => ({ ok: true, status: 400, detail: 'HTTP 400 Bad Request（2008 Invalid provider）（令牌已被网关接受，仅该探测路径不适用）' }),
    })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'cfut_x' }, deps)
    check(r.ok === true, '400 Invalid provider → 初始化继续（不再误判失败）')
    const step = r.steps.find((s) => s.step === 'cfut_xxx')
    check(step && step.ok === true && step.message.includes('已通过网关认证'), 'cfut 步骤标为「已通过网关认证」')
    check(deps.calls.some((c) => c[0] === 'writeMgmt'), '认证放行后正常落盘')
  }

  // 无既有 KV → 创建
  {
    const deps = makeDeps({ listKVNamespacesFn: async () => [] })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'cfut_x' }, deps)
    check(r.ok === true && r.kvNamespaceId === 'kv-new', '无既有 KV → 创建并回填')
    check(deps.calls.some((c) => c[0] === 'createKv' && c[2] === KV_NAMESPACE_TITLE), '创建 models-kv')
  }

  // KV 失败 → 尽力而为，整体仍 ok 但带 warning，不写 kv
  {
    const deps = makeDeps({ listKVNamespacesFn: async () => { throw new Error('KV 权限不足') } })
    const r = await completeOnboarding({ managementToken: 'mgt', accountId: 'acc', gatewayToken: 'cfut_x' }, deps)
    check(r.ok === true, 'KV 失败不阻断初始化')
    check(r.warnings && r.warnings[0].includes('KV namespace 未配置'), '记录 KV 告警')
    const merge = deps.calls.find((c) => c[0] === 'merge')
    check(merge[1].kv === undefined, 'KV 失败时不写 kv 分块')
    check(merge[1].gateway.gatewayId === DEFAULT_GATEWAY_ID, '缺省 gatewayId 用默认值')
  }
}

// ── createGateway 请求体（回归：7001 "Expected number, received nan"）──
// 仅传 { id, authentication } 时 Cloudflare 会因缺失数值字段报 7001，
// 故必须显式给出 cache_ttl / rate_limiting_* 等必需字段。
section('createGateway')
{
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ success: true, result: { id: 'cf-ai-gateway' } }),
    }
  }

  try {
    const r = await createGateway('tok', 'acc', 'cf-ai-gateway')
    check(r && r.id === 'cf-ai-gateway', '返回 gateway 对象')
    check(calls.length === 1, '只发 1 次请求')
    const { url, init } = calls[0]
    check(url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/gateways', 'POST URL 正确')
    check(init.method === 'POST', 'method = POST')
    const body = JSON.parse(init.body)
    check(body.id === 'cf-ai-gateway', 'body.id 正确')
    check(body.authentication === true, 'body.authentication = true')
    check(typeof body.cache_ttl === 'number' && body.cache_ttl === 0, 'cache_ttl 为数值（避开 7001）')
    check(typeof body.rate_limiting_interval === 'number', 'rate_limiting_interval 为数值')
    check(typeof body.rate_limiting_limit === 'number', 'rate_limiting_limit 为数值')
    check(typeof body.cache_invalidate_on_update === 'boolean', 'cache_invalidate_on_update 为布尔')
    check(typeof body.collect_logs === 'boolean', 'collect_logs 为布尔')

    // guard：缺 accountId / gatewayId
    let threw = false
    try { await createGateway('tok', '', 'gw') } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 accountId → TypeError')
    threw = false
    try { await createGateway('tok', 'acc', '') } catch (e) { threw = e instanceof TypeError }
    check(threw, '缺 gatewayId → TypeError')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── createGateway 幂等（网关已存在）──────────────────────
// Cloudflare 对重复 id 的返回不一致：历史 409，实测 400 7001
// "An object with this id already exists"。两种都应视为成功并取回现有网关。
section('createGateway 幂等（已存在）')
{
  const originalFetch = globalThis.fetch

  // 400 7001 "already exists" → 回退 getGateway
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (init.method === 'POST') {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({
            success: false,
            errors: [{ code: 7001, message: 'An object with this id already exists' }],
            result: null,
          }),
        }
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ success: true, result: { id: 'cf-ai-gateway', authentication: true } }) }
    }
    try {
      const r = await createGateway('tok', 'acc', 'cf-ai-gateway')
      check(r && r.id === 'cf-ai-gateway', '400 already exists → 返回现有网关（不抛错）')
      check(calls.length === 2 && calls[1].init.method === 'GET', '回退 GET 查现有网关')
      check(calls[1].url === 'https://api.cloudflare.com/client/v4/accounts/acc/ai-gateway/gateways/cf-ai-gateway', 'GET URL 正确')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 409（历史行为）→ 仍回退 getGateway
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      if (init.method === 'POST') {
        return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ success: false, errors: [{ code: 1002, message: 'Conflict' }] }) }
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ success: true, result: { id: 'gw' } }) }
    }
    try {
      const r = await createGateway('tok', 'acc', 'gw')
      check(r && r.id === 'gw' && calls.length === 2, '409 → 返回现有网关')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // 其它 400（非 already exists）→ 透传错误，不误判为已存在
  {
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ success: false, errors: [{ code: 7001, message: 'Invalid request body' }] }),
      }
    }
    try {
      let msg = ''
      try {
        await createGateway('tok', 'acc', 'gw')
        check(false, '应抛错')
      } catch (e) {
        msg = e.message
      }
      check(msg.includes('Invalid request body'), '非 already exists 的 400 → 透传错误')
      check(calls.length === 1, '不触发 GET 回退')
    } finally {
      globalThis.fetch = originalFetch
    }
  }
}

// ── verifyGatewayToken：认证失败 vs 网络 vs 非认证类响应（认证已放行）──────
section('verifyGatewayToken')
{
  const originalFetch = globalThis.fetch
  let lastUrl = ''

  // 200 → 通过
  globalThis.fetch = async (url) => {
    lastUrl = url
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ result: [] }) }
  }
  try {
    const r = await verifyGatewayToken('gateway.ai.cloudflare.com', 'acc', 'gw', 'cfut_x')
    check(r.ok === true && r.status === 200, '200 → ok:true')
    check(r.detail === 'verified', '通过时 detail=verified')
    check(lastUrl.includes('/v1/acc/gw/compat/models'), '探测路径为 OpenAI 兼容 /compat/models')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 401 → 失败并带状态码 + Gateway 错误码
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => JSON.stringify({ success: false, error: [{ code: 2009, message: 'Unauthorized' }] }),
  })
  try {
    const r = await verifyGatewayToken('gateway.ai.cloudflare.com', 'acc', 'gw', 'bad')
    check(r.ok === false && r.status === 401, '401 → ok:false + status=401')
    check(r.detail.includes('401') && r.detail.includes('2009'), '401 detail 含状态码与 Gateway 错误码')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 400 "2008 Invalid provider" → 认证已放行，令牌有效（回归真实场景）
  // AI Gateway 先校验 cf-aig-authorization 再解析 provider，故无效令牌必 401；
  // 有效令牌才可能拿到 2008 Invalid provider（首段被当作 provider slug）。
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => JSON.stringify({ success: false, error: [{ code: 2008, message: 'Invalid provider' }] }),
  })
  try {
    const r = await verifyGatewayToken('gateway.ai.cloudflare.com', 'acc', 'gw', 'cfut_x')
    check(r.ok === true && r.status === 400, '400 Invalid provider → 判为令牌已被接受')
    check(r.detail.includes('2008') && r.detail.includes('令牌已被网关接受'), 'detail 说明认证已放行')
  } finally {
    globalThis.fetch = originalFetch
  }

  // 网络失败 → status=null + 根因 + 主机
  globalThis.fetch = async () => {
    const e = new TypeError('fetch failed')
    e.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }
    throw e
  }
  try {
    const r = await verifyGatewayToken('gateway.ai.cloudflare.com', 'acc', 'gw', 'x')
    check(r.ok === false && r.status === null, '网络失败 → ok:false + status=null')
    check(r.detail.includes('UND_ERR_CONNECT_TIMEOUT') && r.detail.includes('gateway.ai.cloudflare.com'), '网络失败 detail 含根因 + 主机')
  } finally {
    globalThis.fetch = originalFetch
  }
}

// ── verifyFailureHint：失败提示分类 ──────────────────────
section('verifyFailureHint')
{
  const auth = verifyFailureHint({ detail: 'HTTP 401 Unauthorized（2009 Unauthorized）', status: 401, accountId: 'acc', gatewayId: 'gw', host: 'gateway.ai.cloudflare.com' })
  check(auth.includes('401') && auth.includes('Authentication') && auth.includes('gateway=gw'), '401 → 绑定/认证提示 + 目标')
  const net = verifyFailureHint({ detail: 'fetch failed（UND_ERR_CONNECT_TIMEOUT @ gateway.ai.cloudflare.com）', status: null, accountId: 'acc', gatewayId: 'gw' })
  check(net.includes('无法连接') && net.includes('UND_ERR_CONNECT_TIMEOUT'), 'status:null → 网络提示')
  const other = verifyFailureHint({ detail: 'HTTP 500 Internal Server Error', status: 500, accountId: 'acc', gatewayId: 'gw' })
  check(other.includes('500') && other.includes('account=acc'), '其它状态 → 透出原因 + 目标')
  check(verifyFailureHint({}).includes('令牌验证失败'), '缺 detail → 兜底文案')
}

// ── providers-config 纯文件读写 ──────────────────────────

section('core/providers-config')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigd-prov-'))
  const configPath = path.join(dir, 'providers.json')
  const backupPath = path.join(dir, 'providers.json.bak')
  const deps = { configPath, backupPath }

  check(readProvidersConfig(deps).providers === undefined, '不存在 → 空对象')

  fs.writeFileSync(configPath, JSON.stringify({
    gateway: { host: 'old-host', accountId: 'old-acc', gatewayId: 'old-gw' },
    kv: { namespaceId: 'ns-old', key: 'models' },
    providers: [{ id: 'openai', name: 'OpenAI', enabled: true }],
    debug: true,
  }, null, 2))

  const { backupPath: bp } = mergeProvidersConfig({ gateway: { accountId: 'acc-1', gatewayId: 'gw-1' } }, deps)
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  check(after.gateway.accountId === 'acc-1' && after.gateway.gatewayId === 'gw-1', '合并覆盖 gateway 字段')
  check(after.gateway.host === 'old-host', 'gateway 其余字段保留')
  check(after.providers.length === 1 && after.providers[0].id === 'openai', 'providers 保留')
  check(after.debug === true, '顶层未知字段保留')
  check(after.kv.namespaceId === 'ns-old', '未传 kv 时原 kv 保留')
  check(bp === backupPath && fs.existsSync(backupPath), '写前备份 .bak')

  backfillKVNamespaceId('ns-new', { configPath })
  const after2 = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  check(after2.kv.namespaceId === 'ns-new' && after2.kv.key === 'models', '回填 kv.namespaceId 保留 key')

  fs.writeFileSync(configPath, '{ not json')
  check(readProvidersConfig(deps).providers === undefined, '损坏文件 → 容错为空')

  // 全新机器：只传 gateway（KV 失败/跳过场景）→ 仍须产出 loadConfig 合法的结构
  const freshPath = path.join(dir, 'fresh.json')
  mergeProvidersConfig(
    { gateway: { accountId: 'acc-x', gatewayId: 'gw-x' } },
    { configPath: freshPath, backupPath: `${freshPath}.bak` }
  )
  const fresh = JSON.parse(fs.readFileSync(freshPath, 'utf8'))
  check(fresh.gateway.host === 'gateway.ai.cloudflare.com', '全新文件补默认 host')
  check(Array.isArray(fresh.providers) && fresh.providers.length === 0, '全新文件补 providers:[]')
  check(fresh.kv && fresh.kv.namespaceId === '' && fresh.kv.key === 'models', '全新文件补 kv 骨架（loadConfig 必需）')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 前端纯函数 ───────────────────────────────────────────

section('前端纯函数')
{
  check(isOnboardingNeeded({ initialized: false }) === true, 'initialized:false → 需要引导')
  check(isOnboardingNeeded({ initialized: true }) === false, 'initialized:true → 不需要')
  check(isOnboardingNeeded(null) === false, 'null → 不打扰')
  check(isOnboardingNeeded({}) === false, '字段缺失 → 不打扰')

  const choices = gatewayChoices([{ id: 'gw-a' }, { id: DEFAULT_GATEWAY_ID }])
  check(choices.length === 2, '已有默认网关 → 不追加新建项')
  const choices2 = gatewayChoices([{ id: 'gw-a' }])
  check(choices2.length === 2 && choices2[1].create === true, '无默认网关 → 追加新建项')
  check(gatewayChoices([]).length === 1, '无网关 → 仅新建项')

  const lines = requiredPermissionLines([
    { scope: 'Account', resource: 'AI Gateway', access: 'Edit', required: true, reason: '建网关' },
    { scope: 'Zone', resource: 'DNS', access: 'Read', required: false, reason: '' },
  ])
  check(lines[0].label === 'Account · AI Gateway · Edit' && lines[0].required === true, '权限行文案 + 必需')
  check(lines[1].required === false, '建议权限标记')

  // 失败文案：后端 200 + ok:false 时展示「标题：错误」+ 各步骤明细
  const fail = failureStatusLines({
    error: '创建/确认 Gateway 失败：fetch failed（UND_ERR_CONNECT_TIMEOUT @ api.cloudflare.com）',
    steps: [{ step: 'Gateway', ok: false, message: '网络请求失败' }],
  })
  check(fail[0].startsWith('初始化失败：'), '首行为「初始化失败：错误」')
  check(fail[1] === '✗ Gateway：网络请求失败', '后续行含步骤明细')
  check(failureStatusLines({}, '读取失败')[0] === '读取失败：未知错误', '缺 error → 兜底「未知错误」')
  check(failureStatusLines({ error: 'x', steps: [{ step: 'KV namespace', ok: true, message: '跳过' }] })[1] === '✓ KV namespace：跳过', '成功步骤带 ✓')
  check(failureStatusLines({ error: 'x', steps: [null, 'bad'] }).length === 1, '非法步骤项跳过')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
