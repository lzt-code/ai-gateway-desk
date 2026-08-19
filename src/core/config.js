import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 解析到项目根目录（ai-gateway-desk/）
 */
function resolveProjectRoot(...segments) {
  return path.resolve(__dirname, '..', '..', ...segments)
}

/**
 * 解析到 data/ 数据目录（运行时数据的唯一存放位置）
 */
function resolveData(...segments) {
  return resolveProjectRoot('data', ...segments)
}

/**
 * 加载并校验 data/providers.json 配置
 * @returns {object} 配置对象
 * @throws {Error} 配置文件缺失或校验失败时抛出
 */
export function loadConfig() {
  const configPath = resolveData('providers.json')

  if (!existsSync(configPath)) {
    throw new Error(
      'data/providers.json 不存在。请复制 data/providers.example.json 为 data/providers.json，并填入真实配置。\n' +
      `  cp data/providers.example.json data/providers.json`
    )
  }

  let raw
  try {
    const content = readFileSync(configPath, 'utf-8')
    raw = JSON.parse(content)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`data/providers.json 格式错误，请检查 JSON 语法：${err.message}`)
    }
    throw err
  }

  // 校验 gateway 字段
  if (!raw.gateway || typeof raw.gateway !== 'object') {
    throw new Error('缺少必需字段: gateway (object)')
  }
  assertField(raw.gateway, 'host', 'string', 'gateway.host')
  assertField(raw.gateway, 'accountId', 'string', 'gateway.accountId')
  assertField(raw.gateway, 'gatewayId', 'string', 'gateway.gatewayId')

  // 校验 kv 字段
  if (!raw.kv || typeof raw.kv !== 'object') {
    throw new Error('缺少必需字段: kv (object)')
  }
  assertField(raw.kv, 'namespaceId', 'string', 'kv.namespaceId')
  if (raw.kv.key !== undefined) {
    assertField(raw.kv, 'key', 'string', 'kv.key')
  } else {
    raw.kv.key = 'models'
  }

  // 校验 providers 字段
  if (!Array.isArray(raw.providers)) {
    throw new Error('缺少必需字段: providers (array)')
  }
  for (let i = 0; i < raw.providers.length; i++) {
    const p = raw.providers[i]
    if (!p || typeof p !== 'object') {
      throw new Error(`providers[${i}] 必须是对象`)
    }
    assertField(p, 'id', 'string', `providers[${i}].id`)
    assertField(p, 'name', 'string', `providers[${i}].name`)
    assertField(p, 'enabled', 'boolean', `providers[${i}].enabled`)
    // pathPrefix 可选：存在时必须是 string
    if (p.pathPrefix !== undefined) {
      assertField(p, 'pathPrefix', 'string', `providers[${i}].pathPrefix`)
    }
  }

  return raw
}

/**
 * 断言字段存在且类型正确，否则抛出带完整路径的错误
 * @param {object} obj
 * @param {string} field
 * @param {string} type - 'string' | 'boolean' | 'array' | 'object'
 * @param {string} path - 错误信息中展示的字段路径
 */
function assertField(obj, field, type, path) {
  const value = obj[field]
  if (value === undefined || value === null) {
    throw new Error(`缺少必需字段: ${path}`)
  }
  const valid =
    type === 'string' ? typeof value === 'string' :
    type === 'boolean' ? typeof value === 'boolean' :
    type === 'array' ? Array.isArray(value) :
    typeof value === 'object'
  if (!valid) {
    throw new Error(`${path} 类型错误: 应为 ${type}，实际为 ${typeof value}`)
  }
}
