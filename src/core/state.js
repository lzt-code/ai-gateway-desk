import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * 解析到 data/ 数据目录（运行时数据的唯一存放位置）
 */
function resolveData(...segments) {
  return path.resolve(__dirname, '..', '..', 'data', ...segments)
}

const STATE_FILE = resolveData('model-states.json')

/**
 * 读取 data/model-states.json，文件不存在时返回 {}
 * @returns {object}
 */
export function loadState() {
  if (!existsSync(STATE_FILE)) {
    return {}
  }

  const content = readFileSync(STATE_FILE, 'utf-8')
  return JSON.parse(content)
}

/**
 * 写入 data/model-states.json，JSON 格式化（2 空格缩进）
 * @param {object} state
 */
export function saveState(state) {
  const dir = path.dirname(STATE_FILE)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

/**
 * 插入或更新一个模型条目
 * @param {object} state
 * @param {string} modelId
 * @param {string} provider
 * @param {object} metadata
 * @param {object} [options]
 * @param {boolean} [options.manual] - 是否为手工添加（手工模型在同步时不因拉取不到而被标记 removed）
 */
export function upsertModel(state, modelId, provider, metadata, options = {}) {
  const entry = {
    status: 'selected',
    provider,
    metadata: { id: modelId, ...metadata, id: modelId }
  }
  if (options.manual) entry.manual = true
  state[modelId] = entry
}

/**
 * 删除一个模型条目
 * @param {object} state
 * @param {string} modelId
 */
export function removeModel(state, modelId) {
  delete state[modelId]
}

/**
 * 返回所有 status === "selected" 的条目
 * @param {object} state
 * @returns {Array<{ id: string, status: string, provider: string, metadata: object }>}
 */
export function getSelected(state) {
  return getByStatus(state, 'selected')
}

/**
 * 按状态过滤
 * @param {object} state
 * @param {string} status
 * @returns {Array<{ id: string, status: string, provider: string, metadata: object }>}
 */
export function getByStatus(state, status) {
  return Object.entries(state)
    .filter(([, entry]) => entry.status === status)
    .map(([id, entry]) => ({ id, ...entry }))
}
