/**
 * Web 初始化引导（onboarding）逻辑层测试
 *
 * 覆盖：
 *   - isInitialized：无 / 本地 / env 管理 Token 的判定
 *   - discoverOnboarding：解析账户 + 列网关（成功 / 多账户选择 / 无账户 / 失败）
 *   - completeOnboarding：确认网关 → 验证 cfut → 保存 → KV → 写配置
 *     （成功 / 网关失败 / cfut 失败不落盘 / 缺参 / KV 复用 / KV 失败降级）
 *   - core/providers-config 纯文件读写（合并保留其余字段 / 回填 / 损坏容错）
 *   - 前端纯函数：isOnboardingNeeded / gatewayChoices / requiredPermissionLines
 *
 * 全程依赖注入 mock，零触网零真实写盘（providers-config 用临时目录）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isInitialized, discoverOnboarding, completeOnboarding, KV_NAMESPACE_TITLE } from '../src/logic/onboarding.js'
import {
  readProvidersConfig,
  mergeProvidersConfig,
  backfillKVNamespaceId,
} from '../src/core/providers-config.js'
import {
  isOnboardingNeeded,
  gatewayChoices,
  requiredPermissionLines,
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
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)
