// ============================================================
// 网关配置存储模块 — data/gateway.json 读写与校验
// ============================================================
// 双网关方案（docs/DUAL-GATEWAY-PLAN.md §9.1）：
//   {
//     "mode": "local" | "cloud",      // 全局后端选择，默认 local
//     "port": 8788,                    // 本地网关固定端口
//     "cloudWorkerUrl": "https://..."  // cloud 模式的云端 Worker 地址
//   }
//
// 数据目录按 import.meta.url 定位（不依赖 cwd），与其他 src 模块一致；
// 文件缺失 / 损坏时回退默认值，保证网关可冷启动。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 data/ */
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

export const DEFAULT_MODE = 'local'
export const DEFAULT_PORT = 8788
const VALID_MODES = ['local', 'cloud']

/**
 * 返回默认配置（深拷贝字面量，避免共享引用）
 * @returns {{ mode: string, port: number, cloudWorkerUrl: string }}
 */
export function defaultGatewayConfig() {
  return { mode: DEFAULT_MODE, port: DEFAULT_PORT, cloudWorkerUrl: '' }
}

/**
 * 校验并归一化端口号
 * @param {unknown} value
 * @returns {number}
 * @throws 非法时抛错
 */
export function normalizePort(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value.trim())
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('port 必须是 1–65535 之间的整数')
  }
  return value
}

/**
 * 校验模式
 * @param {unknown} value
 * @returns {'local'|'cloud'}
 * @throws 非法时抛错
 */
export function normalizeMode(value) {
  if (typeof value !== 'string' || !VALID_MODES.includes(value)) {
    throw new Error("mode 必须是 'local' 或 'cloud'")
  }
  return /** @type {'local'|'cloud'} */ (value)
}

/**
 * 校验 cloudWorkerUrl：允许空字符串（未配置）或 http(s) URL
 * @param {unknown} value
 * @returns {string}
 * @throws 非法时抛错
 */
export function normalizeCloudWorkerUrl(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('cloudWorkerUrl 必须是字符串')
  const s = value.trim()
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch {
    throw new Error('cloudWorkerUrl 必须是合法的 http(s) URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('cloudWorkerUrl 必须以 http:// 或 https:// 开头')
  }
  return s
}

/**
 * 校验并归一化一份（可能不完整的）网关配置，与默认值合并。
 * @param {unknown} raw
 * @returns {{ mode: 'local'|'cloud', port: number, cloudWorkerUrl: string }}
 * @throws 任一字段非法时抛错（中文消息）
 */
export function validateGatewayConfig(raw) {
  const base = defaultGatewayConfig()
  if (raw === undefined || raw === null) return base
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('gateway 配置必须是对象')
  }
  const obj = /** @type {Record<string, unknown>} */ (raw)
  return {
    mode: obj.mode === undefined ? base.mode : normalizeMode(obj.mode),
    port: obj.port === undefined ? base.port : normalizePort(obj.port),
    cloudWorkerUrl:
      obj.cloudWorkerUrl === undefined ? base.cloudWorkerUrl : normalizeCloudWorkerUrl(obj.cloudWorkerUrl),
  }
}

/**
 * 读取网关配置。文件缺失 / JSON 损坏时回退默认值（不抛错）；
 * 字段非法时抛错（提醒用户修复配置，而非静默改用默认）。
 * @param {string} [dataDir]
 * @returns {{ mode: 'local'|'cloud', port: number, cloudWorkerUrl: string }}
 */
export function loadGatewayConfig(dataDir = DEFAULT_DATA_DIR) {
  const file = path.join(dataDir, 'gateway.json')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return defaultGatewayConfig()
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultGatewayConfig()
  }
  return validateGatewayConfig(parsed)
}

/**
 * 保存网关配置（先校验归一化再写盘）。
 * @param {object} config
 * @param {string} [dataDir]
 * @returns {{ mode: 'local'|'cloud', port: number, cloudWorkerUrl: string }} 归一化后的配置
 */
export function saveGatewayConfig(config, dataDir = DEFAULT_DATA_DIR) {
  const normalized = validateGatewayConfig(config)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'gateway.json'), JSON.stringify(normalized, null, 2) + '\n')
  return normalized
}
