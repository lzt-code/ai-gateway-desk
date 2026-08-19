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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // 调试日志：记录所有进入 Worker 的请求
    console.log(`[REQ] ${request.method} ${url.pathname}`, {
      userAgent: request.headers.get('User-Agent'),
      authorization: request.headers.get('Authorization') ? 'present' : 'absent',
      cfRay: request.headers.get('CF-Ray'),
    })

    // CORS 预检
    if (request.method === 'OPTIONS') {
      // 动态回显请求头，兼容 OpenAI SDK 等发送的 X-Stainless-* 自定义头
      const reqHeaders = request.headers.get('Access-Control-Request-Headers')
      const preflightHeaders = {
        ...CORS_HEADERS,
        ...(reqHeaders ? { 'Access-Control-Allow-Headers': reqHeaders } : {}),
      }
      return new Response(null, { status: 204, headers: preflightHeaders })
    }

    // 校验请求方法
    const isChat = request.method === 'POST' && url.pathname.endsWith('/chat/completions')
    const isModels = request.method === 'GET' && url.pathname.endsWith('/models')

    if (!isChat && !isModels) {
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
    }

    if (isModels) {
      return handleModels(env)
    }

    return handleChat(request, env)
  },
}
