import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 解析到 data/ 数据目录（运行时数据的唯一存放位置）。
 * dataDir 参数仅供测试重定向（默认真实 data/ 目录）。
 */
function defaultDataDir() {
  return path.resolve(__dirname, '..', '..', 'data')
}

/**
 * 路由条目结构（data/routes.json 的 routes[name]）：
 * {
 *   name: string              — 路由名（调用侧 model = dynamic/{name}）
 *   elements: Array<object>   — CF 原生流程图节点（本地真相源，1:1 与云端互转）
 *   cloudId: string|null      — 云端路由 id（列表项 id 字段，首次部署后回填）
 *   deployedVersion: number|string|null — 云端已部署版本号
 *   dirty: boolean            — 本地有未部署修改
 *   lastDeployedAt: string|null
 *   lastSyncedAt: string|null — 最近一次从云端拉取时间
 * }
 */

/**
 * 读取 data/routes.json，文件不存在 / 损坏时返回空骨架 { routes: {} }
 * @param {string} [dataDir] - 数据目录（测试重定向用）
 * @returns {{ routes: Record<string, object> }}
 */
export function loadRoutesStore(dataDir) {
  const file = path.resolve(dataDir || defaultDataDir(), 'routes.json')
  if (!existsSync(file)) {
    return { routes: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (parsed && typeof parsed === 'object' && parsed.routes && typeof parsed.routes === 'object') {
      return parsed
    }
    return { routes: {} }
  } catch {
    // 损坏文件不阻断流程：视为空（与 config.js「读失败回退默认」的容错风格一致）
    return { routes: {} }
  }
}

/**
 * 写入 data/routes.json（JSON 格式化 2 空格缩进，目录不存在时创建）
 * @param {{ routes: Record<string, object> }} store
 * @param {string} [dataDir] - 数据目录（测试重定向用）
 */
export function saveRoutesStore(store, dataDir) {
  const dir = dataDir || defaultDataDir()
  const file = path.resolve(dir, 'routes.json')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf-8')
}

/**
 * 插入或更新一条路由（纯函数，不改入参 store）
 * @param {{ routes: Record<string, object> }} store
 * @param {string} name
 * @param {object} entryPatch - 与现有条目浅合并的字段（elements 等整体覆盖字段直接传）
 * @returns {{ routes: Record<string, object> }} 新 store
 */
export function upsertRoute(store, name, entryPatch) {
  const routes = { ...(store?.routes || {}) }
  const prev = routes[name] || {}
  routes[name] = { ...prev, ...entryPatch, name }
  return { routes }
}

/**
 * 删除一条路由（纯函数）
 * @param {{ routes: Record<string, object> }} store
 * @param {string} name
 * @returns {{ routes: Record<string, object> }} 新 store
 */
export function removeRoute(store, name) {
  const routes = { ...(store?.routes || {}) }
  delete routes[name]
  return { routes }
}
