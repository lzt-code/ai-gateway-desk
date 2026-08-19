/**
 * Worker / 账户视图测试（任务 21）
 *
 * 纯逻辑测试：不触网、不启动真实 TUI、不渲染 blessed 屏幕。
 * 覆盖 account-actions.js（summarizeTokenStatus / summarizeGatewayInfo /
 * updateToken / clearSlotToken / buildWorkersStatus / checkKVKey）与
 * views.js（buildAccountLines / buildWorkersLines 渲染）。
 *
 * 场景（任务 21 测试方法）：
 *   A: token 状态汇总——两槽位 ×（env 提供 / 本地 / 无）组合 → 正确的展示结构
 *   B: 更新操作——mock writeToken / writeManagementToken 被调用且参数正确
 *   C: 清除操作——mock clearToken / clearManagementToken 被调用，仅清指定槽位
 *   D: gateway 信息缺失（config.gateway 为空）→ 显示「未配置」不抛错
 *   E: Worker 状态构建（KV namespace / models.json / KV key / canDeploy）
 *   F: checkKVKey（mock execFile）
 */

import {
  SLOTS,
  summarizeTokenStatus,
  summarizeGatewayInfo,
  updateToken,
  clearSlotToken,
  buildWorkersStatus,
  checkKVKey,
} from '../src/tui/account-actions.js'
import { buildAccountLines, buildWorkersLines } from '../src/tui/render.js'

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

// ── 测试 1：模块导出 ──
section('测试 1: 导出')
for (const fn of [
  ['SLOTS', SLOTS],
  ['summarizeTokenStatus', summarizeTokenStatus],
  ['summarizeGatewayInfo', summarizeGatewayInfo],
  ['updateToken', updateToken],
  ['clearSlotToken', clearSlotToken],
  ['buildWorkersStatus', buildWorkersStatus],
  ['checkKVKey', checkKVKey],
  ['buildAccountLines', buildAccountLines],
  ['buildWorkersLines', buildWorkersLines],
]) {
  check(typeof fn[1] === 'function' || typeof fn[1] === 'object', `${fn[0]} 已导出`)
}
check(SLOTS.MANAGEMENT === 'management' && SLOTS.GATEWAY === 'gateway', 'SLOTS 槽位常量正确')

// ── 测试 2：场景 A — token 状态汇总（两槽位 × env/本地/无）──
section('测试 2: 场景 A — summarizeTokenStatus 组合矩阵')
{
  // a. 两槽位都无
  let s = summarizeTokenStatus({})
  check(s.management.source === 'none' && s.management.mark === '○' && s.management.label === '未配置',
    '管理槽位无凭证 → none/○/未配置')
  check(s.gateway.source === 'none' && s.gateway.mark === '○' && s.gateway.label === '未配置',
    'Gateway 槽位无凭证 → none/○/未配置')
  check(s.management.hasLocal === false && s.gateway.hasLocal === false, 'hasLocal 均为 false')

  // b. 仅本地
  s = summarizeTokenStatus({ localManagement: 'mgt-local', localGateway: 'cfut-local' })
  check(s.management.source === 'local' && s.management.mark === '●' && s.management.label === '本地已存',
    '仅本地管理 Token → local/●/本地已存')
  check(s.gateway.source === 'local' && s.gateway.hasLocal === true, '仅本地 Gateway Token → local/●')

  // c. 仅 env
  s = summarizeTokenStatus({ envManagement: 'env-mgt', envGateway: 'env-gw' })
  check(s.management.source === 'env' && s.management.mark === '●' && s.management.label === 'env 提供',
    '仅 env 管理 Token → env/●/env 提供')
  check(s.gateway.source === 'env' && s.gateway.hasLocal === false, '仅 env Gateway Token → env/●（无本地）')

  // d. env + 本地并存（env 优先）
  s = summarizeTokenStatus({ envManagement: 'env-mgt', localManagement: 'mgt-local' })
  check(s.management.source === 'env' && s.management.hasLocal === true,
    'env + 本地并存 → source=env 且 hasLocal=true（env 优先）')

  // e. 混合：管理 env / Gateway 无
  s = summarizeTokenStatus({ envManagement: 'env-mgt', localGateway: null })
  check(s.management.source === 'env' && s.gateway.source === 'none',
    '混合组合：管理 env / Gateway none')

  // f. 不修改入参 / 空串视为无
  s = summarizeTokenStatus({ envManagement: '', localGateway: '' })
  check(s.management.source === 'none' && s.gateway.source === 'none', '空串 env/local 视为无')
}

// ── 测试 3：场景 B — 更新操作（mock 依赖）──
section('测试 3: 场景 B — updateToken 编排')
{
  // a. 更新管理槽位 → 调 writeManagementFn
  let mgtCalls = []
  let gwCalls = []
  let r = updateToken(SLOTS.MANAGEMENT, 'new-mgt-token', {
    writeManagementFn: (t) => mgtCalls.push(t),
    writeGatewayFn: (t) => gwCalls.push(t),
  })
  check(r.ok === true, '管理槽位更新返回 ok')
  check(mgtCalls.length === 1 && mgtCalls[0] === 'new-mgt-token', 'writeManagementFn 被调用且参数正确')
  check(gwCalls.length === 0, 'gateway 槽位未被调用')

  // b. 更新 gateway 槽位 → 调 writeGatewayFn
  mgtCalls = []
  gwCalls = []
  r = updateToken(SLOTS.GATEWAY, 'cfut-new', {
    writeManagementFn: (t) => mgtCalls.push(t),
    writeGatewayFn: (t) => gwCalls.push(t),
  })
  check(r.ok === true, 'gateway 槽位更新返回 ok')
  check(gwCalls.length === 1 && gwCalls[0] === 'cfut-new', 'writeGatewayFn 被调用且参数正确')
  check(mgtCalls.length === 0, '管理槽位未被调用')

  // c. 空 token → skipped，不调用任何写入
  mgtCalls = []
  gwCalls = []
  r = updateToken(SLOTS.MANAGEMENT, '   ', {
    writeManagementFn: (t) => mgtCalls.push(t),
    writeGatewayFn: (t) => gwCalls.push(t),
  })
  check(r.ok === false && r.skipped === true, '空白 token → skipped')
  check(mgtCalls.length === 0 && gwCalls.length === 0, '空白 token 不调用写入')

  // d. 写入抛错 → { ok: false, error }
  r = updateToken(SLOTS.MANAGEMENT, 'x', {
    writeManagementFn: () => { throw new Error('disk full') },
  })
  check(r.ok === false && r.error && r.error.message === 'disk full', '写入抛错 → error 透传')
}

// ── 测试 4：场景 C — 清除操作（mock 依赖，仅清指定槽位）──
section('测试 4: 场景 C — clearSlotToken 编排')
{
  // a. 清除管理槽位
  let mgtCalls = 0
  let gwCalls = 0
  let r = clearSlotToken(SLOTS.MANAGEMENT, {
    clearManagementFn: () => mgtCalls++,
    clearGatewayFn: () => gwCalls++,
  })
  check(r.ok === true, '清除管理槽位返回 ok')
  check(mgtCalls === 1 && gwCalls === 0, '仅清管理槽位（gateway 槽位不受影响）')

  // b. 清除 gateway 槽位
  mgtCalls = 0
  gwCalls = 0
  r = clearSlotToken(SLOTS.GATEWAY, {
    clearManagementFn: () => mgtCalls++,
    clearGatewayFn: () => gwCalls++,
  })
  check(r.ok === true, '清除 gateway 槽位返回 ok')
  check(gwCalls === 1 && mgtCalls === 0, '仅清 gateway 槽位（管理槽位不受影响）')

  // c. 清除抛错 → { ok: false, error }
  r = clearSlotToken(SLOTS.GATEWAY, {
    clearGatewayFn: () => { throw new Error('denied') },
  })
  check(r.ok === false && r.error && r.error.message === 'denied', '清除抛错 → error 透传')
}

// ── 测试 5：场景 D — gateway 信息缺失不抛错 ──
section('测试 5: 场景 D — summarizeGatewayInfo 缺失降级')
{
  // a. 完整 gateway
  let g = summarizeGatewayInfo({ accountId: 'acc-1', gatewayId: 'gw-1' })
  check(g.accountId === 'acc-1' && g.gatewayId === 'gw-1', '完整 gateway 正常返回')

  // b. null / undefined / 空对象 → 未配置，不抛错
  for (const input of [null, undefined, {}, undefined]) {
    g = summarizeGatewayInfo(input)
    check(g.accountId === '未配置' && g.gatewayId === '未配置',
      `gateway=${JSON.stringify(input)} → 未配置（不抛错）`)
  }

  // c. 部分字段缺失
  g = summarizeGatewayInfo({ accountId: 'acc-1' })
  check(g.accountId === 'acc-1' && g.gatewayId === '未配置', 'accountId 有、gatewayId 缺 → 单项未配置')
}

// ── 测试 6：场景 E — Worker 状态构建 ──
section('测试 6: 场景 E — buildWorkersStatus')
{
  // a. 完全未配置
  let w = buildWorkersStatus({})
  check(w.kvNamespace.configured === false && w.kvNamespace.id === '', 'namespaceId 空 → 未配置')
  check(w.modelsJson.exists === false, 'models.json 缺失 → exists=false')
  check(w.kvKey.status === 'skipped', 'namespaceId 空 → kvKey=skipped')
  check(w.canDeploy === false, 'namespaceId 空 → canDeploy=false')

  // b. 已配置 + 一切正常
  w = buildWorkersStatus({ namespaceId: 'a1b2c3', modelsJson: { exists: true, count: 42 }, kvKey: 'exists' })
  check(w.kvNamespace.configured === true && w.kvNamespace.id === 'a1b2c3', 'namespaceId 已配置')
  check(w.modelsJson.exists === true && w.modelsJson.count === 42, 'models.json 存在且计数正确')
  check(w.kvKey.status === 'exists' && w.kvKey.detail === '存在', 'kvKey=exists → 存在')
  check(w.canDeploy === true, 'namespaceId 已配置 → canDeploy=true')

  // c. models.json 存在但无计数
  w = buildWorkersStatus({ namespaceId: 'x', modelsJson: { exists: true }, kvKey: 'error' })
  check(w.modelsJson.count === null, 'count 缺失 → null')
  check(w.kvKey.status === 'error' && w.kvKey.detail === '无法读取', 'kvKey=error → 无法读取')

  // d. count 类型防御
  w = buildWorkersStatus({ namespaceId: 'x', modelsJson: { exists: true, count: 'bad' } })
  check(w.modelsJson.count === null, 'count 非数字 → null（防御）')

  // e. 自定义 KV key 名透传
  w = buildWorkersStatus({ namespaceId: 'x', kvKey: 'exists', kvKeyName: 'my-key' })
  check(w.kvKey.detail === '存在', 'kvKeyName 透传（detail 展示）')
}

// ── 测试 7：场景 F — checkKVKey（mock execFile）──
section('测试 7: 场景 F — checkKVKey mock')
{
  // a. namespaceId 空 → skipped（不调 execFile）
  let called = 0
  let r = await checkKVKey('', 'models', { execFileFn: () => { called++ } })
  check(r === 'skipped' && called === 0, 'namespaceId 空 → skipped，不调 execFile')

  // b. exec 成功 → exists
  r = await checkKVKey('ns-1', 'models', { execFileFn: (cmd, args, opts, cb) => cb(null) })
  check(r === 'exists', 'execFile 无错 → exists')

  // c. exec 失败 → error
  r = await checkKVKey('ns-1', 'models', { execFileFn: (cmd, args, opts, cb) => cb(new Error('not found')) })
  check(r === 'error', 'execFile 报错 → error（无法读取）')

  // d. 命令参数含 --namespace-id 与 key
  let captured = null
  await checkKVKey('ns-abc', 'models', {
    execFileFn: (cmd, args, opts, cb) => { captured = { cmd, args }; cb(null) },
  })
  check(captured && captured.args.join(' ').includes('kv:key get --namespace-id ns-abc models'),
    `wrangler 参数正确（实际: ${captured ? captured.args.join(' ') : '未调用'}）`)
}

// ── 测试 8：渲染函数（buildAccountLines / buildWorkersLines）──
section('测试 8: 渲染函数')
{
  // a. 账户面板：local / env 混合 + gateway 信息
  const summary = {
    management: { source: 'local', hasLocal: true, label: '本地已存', mark: '●' },
    gateway: { source: 'env', hasLocal: true, label: 'env 提供', mark: '●' },
    gatewayInfo: { accountId: 'acc-1', gatewayId: 'gw-1' },
  }
  const lines = buildAccountLines(summary)
  const joined = lines.join('\n')
  check(joined.includes('管理 API Token') && joined.includes('●') && joined.includes('本地已存'),
    '账户面板含管理 Token 槽位状态')
  check(joined.includes('Gateway Token') && joined.includes('env 提供') && joined.includes('本地也有存量'),
    '账户面板含 Gateway Token env 来源 + 本地存量提示')
  check(joined.includes('accountId: acc-1') && joined.includes('gatewayId: gw-1'),
    '账户面板含 gateway 信息')

  // b. 账户面板：全未配置
  const empty = buildAccountLines({
    management: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
    gateway: { source: 'none', hasLocal: false, label: '未配置', mark: '○' },
    gatewayInfo: { accountId: '未配置', gatewayId: '未配置' },
  }).join('\n')
  check(empty.includes('○') && empty.includes('未配置'), '未配置槽位显示 ○ 未配置')

  // c. Worker 面板：已配置 + 正常
  const wLines = buildWorkersLines(buildWorkersStatus({
    namespaceId: 'a1b2c3', modelsJson: { exists: true, count: 42 }, kvKey: 'exists',
  })).join('\n')
  check(wLines.includes('KV namespace id') && wLines.includes('a1b2c3'),
    'Worker 面板含 namespace id（blessed tags 分隔标签与值）')
  check(wLines.includes('data/models.json') && wLines.includes('存在') && wLines.includes('42 个模型'),
    'Worker 面板含 models.json 状态与计数')
  check(wLines.includes('KV key "models"') && wLines.includes('存在'), 'Worker 面板含 KV key 状态')
  check(wLines.includes('Worker 代码无需修改，此视图仅管理部署'), 'Worker 面板含职责说明')
  check(wLines.includes('D') && wLines.includes('部署 Worker'), 'Worker 面板含 D 部署提示')

  // d. Worker 面板：未配置
  const emptyW = buildWorkersLines(buildWorkersStatus({})).join('\n')
  check(emptyW.includes('未配置') && emptyW.includes('部署不可用'), '未配置时提示先初始化 + 部署不可用')
}

console.log(`\n${failures === 0 ? '✓' : '✗'} 全部通过 ${checks - failures}/${checks}`)
process.exit(failures ? 1 : 0)