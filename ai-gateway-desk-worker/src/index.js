/**
 * ai-gateway-desk-worker — Cloudflare Worker 入口
 *
 * 职责：薄路由分发（CORS 预检 / 路由判定），具体端点逻辑见 routes/。
 * 保持无状态、无密钥、纯 header 翻译层。
 *
 * @module ai-gateway-desk-worker/src/index
 */

import { CORS_HEADERS } from './http.js'
import { handleChat } from './routes/chat.js'
import { handleModels } from './routes/models.js'
import { setDebug, logRequest, logResult } from './io-log.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    setDebug(env?.IO_DEBUG === 'true')

    // 入站请求日志：默认记录结果，debug 开启时记录请求细节（authorization 脱敏）
    logRequest('worker:req', {
      method: request.method,
      url: url.pathname,
      headers: {
        'User-Agent': request.headers.get('User-Agent') ?? '',
        'Authorization': request.headers.get('Authorization') ? 'present' : 'absent',
        'CF-Ray': request.headers.get('CF-Ray') ?? '',
      },
    })

    // CORS 预检
    if (request.method === 'OPTIONS') {
      // 动态回显请求头，兼容 OpenAI SDK 等发送的 X-Stainless-* 自定义头
      const reqHeaders = request.headers.get('Access-Control-Request-Headers')
      const preflightHeaders = {
        ...CORS_HEADERS,
        ...(reqHeaders ? { 'Access-Control-Allow-Headers': reqHeaders } : {}),
      }
      logResult('worker:req', { ok: true, message: 'OPTIONS 204' })
      return new Response(null, { status: 204, headers: preflightHeaders })
    }

    // 校验请求方法
    const isChat = request.method === 'POST' && url.pathname.endsWith('/chat/completions')
    const isModels = request.method === 'GET' && url.pathname.endsWith('/models')

    if (!isChat && !isModels) {
      logResult('worker:req', { ok: false, message: `404 ${url.pathname}` })
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
    }

    if (isModels) {
      return handleModels(env)
    }

    return handleChat(request, env)
  },
}
