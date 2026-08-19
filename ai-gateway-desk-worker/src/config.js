/**
 * Gateway 配置 — 从 Worker env 读取（任务 13，开源前置）
 *
 * 硬编码值已移除，改为由用户在 wrangler.toml [vars] 或 secret 中配置：
 * - GW_HOST（可选，默认 gateway.ai.cloudflare.com）
 * - ACCOUNT_ID（必填）
 * - GATEWAY_ID（必填）
 *
 * provider 路由映射（pathPrefix）从 KV 读取，键名 provider-routes。
 *
 * @module ai-gateway-desk-worker/src/config
 */

/**
 * 从 Worker env 读取 Gateway 配置
 * @param {object} env - Worker 环境变量
 * @returns {{ host: string, accountId: string, gatewayId: string }}
 * @throws {Error} ACCOUNT_ID / GATEWAY_ID 缺失时抛错
 */
export function getGatewayConfig(env) {
  const host = env.GW_HOST ?? 'gateway.ai.cloudflare.com'
  const accountId = env.ACCOUNT_ID
  const gatewayId = env.GATEWAY_ID
  if (!accountId || !gatewayId) {
    throw new Error(
      '缺少 ACCOUNT_ID / GATEWAY_ID 环境变量，请在 wrangler.toml [vars] 或 secret 中配置'
    )
  }
  return { host, accountId, gatewayId }
}
