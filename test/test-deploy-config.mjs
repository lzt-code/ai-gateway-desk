// scripts/deploy.mjs 纯函数验证（buildWranglerConfig / buildGatewayConfig，无需触网）
// 覆盖：KV 占位符替换 / 空 id 抛错 / 无占位符抛错 / gateway 配置注入 / 缺失字段抛错
import { buildWranglerConfig, buildGatewayConfig, ACCOUNT_ID_PLACEHOLDER, GATEWAY_ID_PLACEHOLDER } from '../scripts/deploy.mjs'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

const TEMPLATE = `name = "ai-gateway-desk-worker"
[vars]
GW_HOST = "gateway.ai.cloudflare.com"
ACCOUNT_ID = "{{ACCOUNT_ID}}"
GATEWAY_ID = "{{GATEWAY_ID}}"

[[kv_namespaces]]
binding = "MODELS_KV"
id = "<YOUR_KV_NAMESPACE_ID>"
`

// ── 场景 1：占位符替换为真实 id ──
{
  const out = buildWranglerConfig(TEMPLATE, 'f1f0ad22846a492787bd43fec07a5ea0')
  check('场景1 id 已替换', out.includes('id = "f1f0ad22846a492787bd43fec07a5ea0"'), true)
  check('场景1 占位符已消失', out.includes('<YOUR_KV_NAMESPACE_ID>'), false)
  check('场景1 其余内容保留', out.includes('binding = "MODELS_KV"') && out.includes('GW_HOST'), true)
}

// ── 场景 2：空 id 抛错 ──
{
  let threw = false
  try { buildWranglerConfig(TEMPLATE, '') } catch { threw = true }
  check('场景2 空 id 抛错', threw, true)
}

// ── 场景 3：模板无占位符抛错（防止覆盖已有真实值 / 双 id） ──
{
  const noPlaceholder = TEMPLATE.replace('<YOUR_KV_NAMESPACE_ID>', 'real-id-already')
  let threw = false
  try { buildWranglerConfig(noPlaceholder, 'new-id') } catch { threw = true }
  check('场景3 无占位符抛错', threw, true)
}

// ── 场景 4：buildGatewayConfig 注入 accountId / gatewayId ──
{
  const out = buildGatewayConfig(TEMPLATE, { accountId: 'abc123', gatewayId: 'my-gw' })
  check('场景4 accountId 已替换', out.includes('ACCOUNT_ID = "abc123"'), true)
  check('场景4 gatewayId 已替换', out.includes('GATEWAY_ID = "my-gw"'), true)
  check('场景4 占位符已消失', out.includes(ACCOUNT_ID_PLACEHOLDER), false)
  check('场景4 占位符已消失2', out.includes(GATEWAY_ID_PLACEHOLDER), false)
  check('场景4 KV 占位符保留', out.includes('<YOUR_KV_NAMESPACE_ID>'), true)
}

// ── 场景 5：buildGatewayConfig 空对象抛错 ──
{
  let threw = false
  try { buildGatewayConfig(TEMPLATE, {}) } catch { threw = true }
  check('场景5 空对象抛错', threw, true)
}

// ── 场景 6：buildGatewayConfig 缺字段抛错 ──
{
  let threw = false
  try { buildGatewayConfig(TEMPLATE, { accountId: 'acc' }) } catch { threw = true }
  check('场景6 缺 gatewayId 抛错', threw, true)
}

// ── 场景 7：完整流程 — 先 KV 后 gateway ──
{
  const step1 = buildWranglerConfig(TEMPLATE, 'f1f0ad22846a492787bd43fec07a5ea0')
  const step2 = buildGatewayConfig(step1, { accountId: 'abc123', gatewayId: 'my-gw' })
  check('场景7 KV id 正确', step2.includes('id = "f1f0ad22846a492787bd43fec07a5ea0"'), true)
  check('场景7 accountId 正确', step2.includes('ACCOUNT_ID = "abc123"'), true)
  check('场景7 gatewayId 正确', step2.includes('GATEWAY_ID = "my-gw"'), true)
}

console.log(failed ? '\n存在失败项' : '\n全部通过 ✓')
process.exit(failed ? 1 : 0)
