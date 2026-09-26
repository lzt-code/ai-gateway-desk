/**
 * 管理 API Token 自检验证脚本（账户页「管理 API Token」卡）
 *
 * 覆盖：
 *  - parsePermissionGroupName：权限组名 → { resource, access }（含冒号资源名）
 *  - analyzeTokenPermissions：required 命中 / Write 满足 Edit / Edit 满足 Read /
 *    Run 独立 / deny 忽略 / 未知组不影响
 *  - pickTokenById：命中 / 未命中 / 非数组
 *  - fetchManagementTokenInfo：未配置 / 正常 / verify 失败 / list 403（权限不可读）/
 *    列表未命中
 *  - REQUIRED_PERMISSIONS 清单：三项必需 Edit + API Tokens Read
 *
 * 全 mock：verifyTokenFn / listTokensFn 注入，零触网。
 */

import {
  REQUIRED_PERMISSIONS,
  parsePermissionGroupName,
  analyzeTokenPermissions,
  pickTokenById,
  buildUnknownPermissions,
  buildPermissionsWithTokenRead,
  fetchManagementTokenInfo,
} from '../src/cloudflare/token-info.js'

let failures = 0
let checks = 0

function check(cond, msg) {
  checks++
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

// ── 1：parsePermissionGroupName ───────────────────────────
section('parsePermissionGroupName')
{
  const a = parsePermissionGroupName('Workers KV Storage Edit')
  check(a.resource === 'Workers KV Storage' && a.access === 'edit', 'KV Edit → { Workers KV Storage, edit }')
  const b = parsePermissionGroupName('AI Gateway Run')
  check(b.resource === 'AI Gateway' && b.access === 'run', 'AI Gateway Run → run')
  const c = parsePermissionGroupName('Zone Read')
  check(c.resource === 'Zone' && c.access === 'read', 'Zone Read → read')
  const d = parsePermissionGroupName('Access: Apps and Policies Read')
  check(d.resource === 'Access: Apps and Policies' && d.access === 'read', '含冒号资源名正确切分')
  const e = parsePermissionGroupName('Weird Name')
  check(e.resource === 'Weird Name' && e.access === '', '无法识别访问级别 → access 空串')
  const f = parsePermissionGroupName(null)
  check(f.resource === '' && f.access === '', 'null → 空对象（不抛错）')
}

// ── 2：analyzeTokenPermissions ────────────────────────────
section('analyzeTokenPermissions')
{
  const policies = [
    {
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.abc': '*' },
      permission_groups: [
        { id: '1', name: 'AI Gateway Edit' },
        { id: '2', name: 'Workers Scripts Edit' },
        { id: '3', name: 'Workers KV Storage Write' },
        { id: '4', name: 'API Tokens Read' },
      ],
    },
    {
      effect: 'allow',
      resources: { 'com.cloudflare.api.account.zone.xyz': '*' },
      permission_groups: [{ id: '5', name: 'Zone Read' }],
    },
  ]
  const result = analyzeTokenPermissions(policies)
  const byId = Object.fromEntries(result.map((r) => [r.id, r]))
  check(byId['ai-gateway-edit'].granted === true, 'AI Gateway Edit → granted')
  check(byId['workers-scripts-edit'].granted === true, 'Workers Scripts Edit → granted')
  check(byId['workers-kv-edit'].granted === true, 'KV Write 满足 KV Edit（写隐含编辑）')
  check(byId['api-tokens-read'].granted === true, 'API Tokens Read → granted')
  check(byId['zone-read'].granted === true, 'Zone Read → granted')
  check(byId['ai-gateway-run'].granted === false && byId['ai-gateway-run'].required === false, 'AI Gateway Run 缺失 → granted false（建议项）')
  check(byId['workers-routes-read'].granted === false, 'Workers Routes Read 缺失 → false')
  check(byId['ai-gateway-edit'].grantedName === 'AI Gateway Edit', '记录命中的权限组名')
}
{
  // Write 组满足 Read 要求
  const custom = [{ id: 'x', resource: 'API Tokens', access: 'Read', required: true, label: 'API Tokens · Read', reason: '' }]
  const r1 = analyzeTokenPermissions([{ effect: 'allow', permission_groups: [{ name: 'API Tokens Write' }] }], custom)
  check(r1[0].granted === true, 'Write 满足 Read 要求')
  const r2 = analyzeTokenPermissions([{ effect: 'allow', permission_groups: [{ name: 'API Tokens Read' }] }], custom)
  check(r2[0].granted === true, 'Read 满足 Read 要求')
  // Edit 不满足 Run
  const customRun = [{ id: 'y', resource: 'AI Gateway', access: 'Run', required: false, label: 'AI Gateway · Run', reason: '' }]
  const r3 = analyzeTokenPermissions([{ effect: 'allow', permission_groups: [{ name: 'AI Gateway Edit' }] }], customRun)
  check(r3[0].granted === false, 'Edit 不满足 Run（Run 为独立能力）')
}
{
  // deny policy 忽略；空 policies → 全部 false
  const r = analyzeTokenPermissions([{ effect: 'deny', permission_groups: [{ name: 'AI Gateway Edit' }] }])
  check(r.find((x) => x.id === 'ai-gateway-edit').granted === false, 'deny 策略被忽略')
  const r2 = analyzeTokenPermissions(null)
  check(r2.length === REQUIRED_PERMISSIONS.length && r2.every((x) => x.granted === false), '空 policies → 全项 false')
}

// ── 3：pickTokenById ──────────────────────────────────────
section('pickTokenById')
{
  const tokens = [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }]
  check(pickTokenById(tokens, 't2').name === 'B', '按 id 命中')
  check(pickTokenById(tokens, 't9') === null, '未命中 → null')
  check(pickTokenById(null, 't1') === null, '非数组 → null')
  check(pickTokenById(tokens, null) === null, '无 id → null')
}

// ── 4：fetchManagementTokenInfo ───────────────────────────
section('fetchManagementTokenInfo')
{
  const noToken = await fetchManagementTokenInfo('', {})
  check(noToken.ok === true && noToken.configured === false, '无令牌 → { ok:true, configured:false }（不发请求）')
}
{
  const calls = []
  const info = await fetchManagementTokenInfo('mgt', {
    verifyTokenFn: async (t) => {
      calls.push(['verify', t])
      return { id: 't1', status: 'active' }
    },
    listTokensFn: async (t) => {
      calls.push(['list', t])
      return [
        { id: 't0', name: 'Other', policies: [] },
        {
          id: 't1',
          name: 'My Token',
          policies: [{ effect: 'allow', permission_groups: [{ name: 'AI Gateway Edit' }] }],
        },
      ]
    },
  })
  check(info.ok === true && info.configured === true, '正常路径 ok/configured')
  check(info.tokenId === 't1' && info.status === 'active', 'tokenId/status 透传')
  check(info.name === 'My Token', '按 verify id 匹配令牌名称')
  check(info.permissionsReadable === true, 'permissionsReadable true')
  check(info.permissions.find((p) => p.id === 'ai-gateway-edit').granted === true, '权限比对命中 AI Gateway Edit')
  check(calls.length === 2 && calls[0][0] === 'verify' && calls[1][0] === 'list', '先 verify 后 list')
}
{
  const info = await fetchManagementTokenInfo('bad', {
    verifyTokenFn: async () => {
      throw new Error('401: invalid token')
    },
  })
  check(info.ok === false && info.configured === true, 'verify 失败 → ok:false')
  check(info.error.includes('invalid token'), 'error 透传')
  check(Array.isArray(info.permissions) && info.permissions.length === REQUIRED_PERMISSIONS.length, 'verify 失败仍返回完整权限清单骨架')
  check(info.permissions.every((p) => p.granted === null), 'verify 失败 → 全部 granted=null')
}
{
  const info = await fetchManagementTokenInfo('mgt', {
    verifyTokenFn: async () => ({ id: 't1', status: 'active' }),
    listTokensFn: async () => {
      const err = new Error('403: Forbidden')
      err.status = 403
      throw err
    },
  })
  check(info.ok === true && info.configured === true, 'list 403 → 仍 ok:true（令牌有效）')
  check(info.permissionsReadable === false, 'list 失败 → permissionsReadable false')
  check(Array.isArray(info.permissions) && info.permissions.length === REQUIRED_PERMISSIONS.length, 'list 失败 → 清单仍返回（长度一致）')
  check(
    info.permissions.filter((p) => p.id !== 'api-tokens-read').every((p) => p.granted === null),
    'list 失败 → 其余项保持未知',
  )
  check(info.tokenId === 't1', 'list 失败仍保留 tokenId')
  check(info.error.includes('403'), 'error 透传 403')
  check(info.errorStatus === 403, 'errorStatus 透传 403')
  check(
    info.permissions.find((p) => p.id === 'api-tokens-read').granted === false,
    '403 → 明确标记 api-tokens-read 缺失',
  )
}
{
  const info = await fetchManagementTokenInfo('mgt', {
    verifyTokenFn: async () => ({ id: 't1', status: 'active' }),
    listTokensFn: async () => [{ id: 't9', name: 'Other', policies: [] }],
  })
  check(info.permissionsReadable === false && info.name === null, '列表未命中当前令牌 → 不可读')
  check(info.permissions.every((p) => p.granted === null || p.id === 'api-tokens-read'), '列表未命中 → 其余保持未知')
  check(
    info.permissions.find((p) => p.id === 'api-tokens-read').granted === true,
    'list 成功 → api-tokens-read 判定为具备',
  )
}

// ── 4b：buildUnknownPermissions / buildPermissionsWithTokenRead ──
section('buildUnknownPermissions')
{
  const list = buildUnknownPermissions()
  check(list.length === REQUIRED_PERMISSIONS.length, '长度与所需权限一致')
  check(list.every((p) => p.granted === null && p.grantedName === null), '全部 granted/grantedName 为 null')
  check(list[0].label === REQUIRED_PERMISSIONS[0].label, '保留 label/reason 展示字段')
  const custom = buildUnknownPermissions([{ id: 'x', resource: 'R', access: 'Read', required: true, label: 'L', reason: 'why' }])
  check(custom.length === 1 && custom[0].id === 'x', '支持自定义清单入参')
}

section('buildPermissionsWithTokenRead')
{
  const missing = buildPermissionsWithTokenRead(false)
  const readRow = missing.find((p) => p.id === 'api-tokens-read')
  check(readRow.granted === false, '传 false → api-tokens-read 标记缺失')
  check(missing.filter((p) => p.id !== 'api-tokens-read').every((p) => p.granted === null), '其余项保持未知')
  const granted = buildPermissionsWithTokenRead(true)
  check(granted.find((p) => p.id === 'api-tokens-read').granted === true, '传 true → api-tokens-read 标记具备')
  const unknown = buildPermissionsWithTokenRead(null)
  check(unknown.find((p) => p.id === 'api-tokens-read').granted === null, '传 null → 保持未知')
}

// ── 5：REQUIRED_PERMISSIONS 清单 ──────────────────────────
section('REQUIRED_PERMISSIONS')
{
  const ids = REQUIRED_PERMISSIONS.map((p) => p.id)
  check(ids.includes('ai-gateway-edit') && ids.includes('workers-scripts-edit') && ids.includes('workers-kv-edit'), '含三项必需 Edit')
  check(ids.includes('api-tokens-read'), '含 API Tokens · Read（本卡信息依赖）')
  const required = REQUIRED_PERMISSIONS.filter((p) => p.required)
  check(required.length === 4, '必需项共 4 条')
  check(Object.isFrozen(REQUIRED_PERMISSIONS), '清单为冻结常量')
  check(REQUIRED_PERMISSIONS.every((p) => typeof p.reason === 'string' && p.reason.trim().length > 0), '每项权限都有用途说明')
  const zone = REQUIRED_PERMISSIONS.find((p) => p.id === 'zone-read')
  const routes = REQUIRED_PERMISSIONS.find((p) => p.id === 'workers-routes-read')
  check(!!zone && !!routes, '含网关页地址发现所需 Zone / Workers Routes 权限')
  check(zone.reason.includes('Cloudflare 网关') && zone.reason.includes('自定义域名'), 'Zone Read 用途指向网关页自定义域名')
  check(routes.reason.includes('Cloudflare 网关') && routes.reason.includes('自定义域名'), 'Workers Routes Read 用途指向网关页自定义域名')
}

console.log(`\n${checks} 项检查, ${failures} 项失败`)
process.exit(failures ? 1 : 0)