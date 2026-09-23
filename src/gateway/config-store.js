// ============================================================
// 网关配置存储模块 — data/gateway.json 读写与校验
// ============================================================
// 本地网关只做本机出口 IP 直发：
//   {
//     "port": 8788                    // 本地网关固定端口
//   }
//
// Cloudflare 路线（共享边缘 IP）由 Agent 直连 Cloudflare 网关，不经本地网关；
// Worker 地址由 Cloudflare API 自动发现，不落地存储。
//
// 数据目录按 import.meta.url 定位（不依赖 cwd），与其他 src 模块一致；
// 文件缺失 / 损坏时回退默认值，保证网关可冷启动。
// ============================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** src/gateway/ → 项目根 data/ */
export const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data')

export const DEFAULT_PORT = 8788

/**
 * 返回默认配置（深拷贝字面量，避免共享引用）
 * @returns {{ port: number }}
 */
export function defaultGatewayConfig() {
  return { port: DEFAULT_PORT }
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
 * 校验并归一化一份（可能不完整的）网关配置，与默认值合并。
 * @param {unknown} raw
 * @returns {{ port: number }}
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
    port: obj.port === undefined ? base.port : normalizePort(obj.port),
  }
}

/**
 * 读取网关配置。文件缺失 / JSON 损坏时回退默认值（不抛错）；
 * 字段非法时抛错（提醒用户修复配置，而非静默改用默认）。
 * @param {string} [dataDir]
 * @returns {{ port: number }}
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
 * @returns {{ port: number }} 归一化后的配置
 */
export function saveGatewayConfig(config, dataDir = DEFAULT_DATA_DIR) {
  const normalized = validateGatewayConfig(config)
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'gateway.json'), JSON.stringify(normalized, null, 2) + '\n')
  return normalized
}
