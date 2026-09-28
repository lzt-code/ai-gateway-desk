// ============================================================
// 上游响应归一化 — 交给 Hono 之前去掉 undici 的 immutable guard
// ============================================================
// undici fetch() 返回的 Response，其 headers 的 guard 为 'immutable'。
// 这类 Response 一旦成为 Hono 的 c.res，后续任何 set 头（如 CORS 中间件
// 在 await next() 之后补 Access-Control-Allow-Origin）都会抛
// `TypeError: immutable`；经 @hono/node-server 响应时 500/请求直接挂死，
// 上游真实状态码（404/401…）与响应体被吞掉，排查成本极高。
//
// 因此在 backend 边界重建一份 headers 可写的 Response。注意 init 必须是
// 普通对象 —— 若把原 Response 当 init 传入（new Response(body, res)），
// 按 Fetch 规范 immutable guard 会被继承，问题依旧。
//
// 重建时同步修正两类“复制即错”的响应头：
//   1. undici 已按 content-encoding 解压 body，但仍保留原头。若原样透传，
//      下游会按压缩体二次解压失败；content-length 也会停留在压缩后长度，
//      导致下游等待/截断（表现为请求挂死）。
//   2. 逐跳头（connection / keep-alive / transfer-encoding / upgrade）
//      只属于上一跳，不应重复转发给下游。
// body 流本身原样透传（SSE / 流式补全兼容）。
// ============================================================

/** 逐跳头：网关这一跳需要丢弃 */
const HOP_BY_HOP_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade']

/** undici fetch 会自动解压的内容编码（解压后头部必须去掉） */
const DECODED_CONTENT_ENCODINGS = new Set(['gzip', 'x-gzip', 'deflate', 'br', 'zstd'])

/**
 * 复制上游 Response，令其 headers 可写（guard 非 immutable），并修正已解压响应头
 * @param {Response} res - 上游 fetch 返回的 Response（headers guard 可能为 immutable）
 * @returns {Response}
 */
export function toMutableResponse(res) {
  const headers = new Headers(res.headers)
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)

  const encodings = (headers.get('content-encoding') || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (encodings.length > 0 && encodings.every((e) => DECODED_CONTENT_ENCODINGS.has(e))) {
    headers.delete('content-encoding')
    headers.delete('content-length')
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}
