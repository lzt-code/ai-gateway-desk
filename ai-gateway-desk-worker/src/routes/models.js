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
import { logRequest, logResult } from '../io-log.js'

/**
 * 处理 models 请求
 * @param {object} env - Worker 环境（含 MODELS_KV 绑定）
 * @returns {Promise<Response>}
 */
export async function handleModels(env) {
  const op = 'worker:models'
  const start = Date.now()
  let models
  let kvOk = false
  try {
    const stored = await env.MODELS_KV.get('models', 'json')
    kvOk = true
    logRequest(op, {
      method: 'GET',
      path: 'KV:models',
      meta: { isArray: Array.isArray(stored), preview: JSON.stringify(stored)?.substring(0, 100) },
    })
    models = stored ?? defaultModels
  } catch (err) {
    models = defaultModels
    logResult(op, {
      ok: false,
      message: `KV 读取失败，使用内置列表: ${err.message}`,
      elapsedMs: Date.now() - start,
    })
    return jsonResponse({ object: 'list', data: models })
  }

  logResult(op, {
    ok: Array.isArray(models),
    message: `${Array.isArray(models) ? models.length : 'not array'} 个模型`,
    elapsedMs: Date.now() - start,
    extra: kvOk ? 'source=kv/default' : '',
  })
  return jsonResponse({ object: 'list', data: models })
}
