/**
 * GET /models — 返回精选模型列表，不走 AI Gateway
 *
 * 注意：模型列表端点公开（无需 Authorization），因为许多 OAI 兼容插件
 * 在获取模型列表时不会发送认证头，只在 /chat/completions 中发送。
 *
 * @module ai-gateway-desk-worker/src/routes/models
 */

import defaultModels from '../models-list.js'
import { jsonResponse } from '../http.js'

/**
 * 处理 models 请求
 * @param {object} env - Worker 环境（含 MODELS_KV 绑定）
 * @returns {Promise<Response>}
 */
export async function handleModels(env) {
  let models
  try {
    const stored = await env.MODELS_KV.get('models', 'json')
    console.log(`[MODELS] KV stored type: ${typeof stored}, isArray: ${Array.isArray(stored)}, value:`, JSON.stringify(stored)?.substring(0, 100))
    models = stored ?? defaultModels
    console.log(`[MODELS] Final models count: ${Array.isArray(models) ? models.length : 'not array'}`)
  } catch (err) {
    console.error(`[MODELS] KV read error:`, err.message)
    models = defaultModels
  }

  return jsonResponse({ object: 'list', data: models })
}
