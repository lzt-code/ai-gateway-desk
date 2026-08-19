// 任务 13 验证脚本：Worker 配置 env 化
// 覆盖：getGatewayConfig 纯逻辑（缺省/必填/自定义）+ handleChat 缺 env 500 分支 + 转发 URL/Header 映射
import { getGatewayConfig } from '../ai-gateway-desk-worker/src/config.js'
import { handleChat } from '../ai-gateway-desk-worker/src/routes/chat.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}

// ── 1. getGatewayConfig：完整配置 + 自定义 GW_HOST
{
  const env = { GW_HOST: 'my-gw.example.com', ACCOUNT_ID: 'acc-1', GATEWAY_ID: 'gw-1' }
  check('完整配置', getGatewayConfig(env), { host: 'my-gw.example.com', accountId: 'acc-1', gatewayId: 'gw-1' })
}

// ── 2. getGatewayConfig：GW_HOST 缺省默认值
{
  const env = { ACCOUNT_ID: 'acc-1', GATEWAY_ID: 'gw-1' }
  check('GW_HOST 默认值', getGatewayConfig(env), { host: 'gateway.ai.cloudflare.com', accountId: 'acc-1', gatewayId: 'gw-1' })
}

// ── 3. getGatewayConfig：缺 ACCOUNT_ID 抛错
{
  let threw = null
  try {
    getGatewayConfig({ GATEWAY_ID: 'gw-1' })
  } catch (err) {
    threw = err.message
  }
  check('缺 ACCOUNT_ID 抛错', threw !== null && threw.includes('ACCOUNT_ID'), true)
}

// ── 4. getGatewayConfig：缺 GATEWAY_ID 抛错
{
  let threw = null
  try {
    getGatewayConfig({ ACCOUNT_ID: 'acc-1' })
  } catch (err) {
    threw = err.message
  }
  check('缺 GATEWAY_ID 抛错', threw !== null && threw.includes('GATEWAY_ID'), true)
}

// ── 5. handleChat：缺 env → 500 友好 JSON（而非裸 500 / 异常冒泡）
{
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer cfut_test', 'Content-Type': 'application/json' },
    body: '{}',
  })
  const res = await handleChat(req, {})
  check('缺 env 状态码', res.status, 500)
  const body = await res.json()
  check('缺 env 错误消息', body.error.includes('ACCOUNT_ID'), true)
}

// ── 6. handleChat：无 Authorization → 401
{
  const req = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    body: '{}',
  })
  const res = await handleChat(req, { ACCOUNT_ID: 'acc-1', GATEWAY_ID: 'gw-1' })
  check('无 Authorization 状态码', res.status, 401)
}

// ── 7. handleChat：正常 env → 转发 URL 与 header 映射正确（mock fetch，不请求真实网络）
{
  const env = { GW_HOST: 'gw.example.com', ACCOUNT_ID: 'acc-1', GATEWAY_ID: 'gw-1' }
  let captured = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured = { url: url.toString(), headers: init.headers, method: init.method }
    return new Response('upstream-ok', { status: 200 })
  }
  try {
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer cfut_test', 'Content-Type': 'application/json' },
      body: '{}',
    })
    const res = await handleChat(req, env)
    check('转发状态码', res.status, 200)
    check(
      '转发 URL',
      captured.url,
      'https://gw.example.com/v1/acc-1/gw-1/compat/chat/completions'
    )
    check('header 映射 cf-aig-authorization', captured.headers.get('cf-aig-authorization'), 'Bearer cfut_test')
    check('header 移除 Authorization', captured.headers.get('Authorization'), null)
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log(failed ? '\n存在失败断言' : '\n全部通过')
process.exit(failed ? 1 : 0)
