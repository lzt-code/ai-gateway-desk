/**
 * HTTP 工具 — CORS 头与 JSON 响应
 * @module ai-gateway-desk-worker/src/http
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Access-Control-Max-Age': '86400',
}

/**
 * 构造 JSON 响应（带 CORS 头）
 * @param {object} body
 * @param {number} status
 * @returns {Response}
 */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  })
}
