import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gatewaySlug } from '../cloudflare/discover.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MODELS_JSON_PATH = path.resolve(__dirname, '..', '..', 'data', 'models.json')
const PROVIDER_ROUTES_KV_KEY = 'provider-routes'

/**
 * 解析 wrangler 命令路径和 exec 参数。
 * Windows 上 .cmd 文件需通过 cmd /c 运行，非 Windows 可直接执行。
 * @returns {{ command: string, args: string[], useShell: boolean }}
 */
function resolveWranglerCommand() {
  // 从 src/output/ 上两级到项目根，找根 node_modules/.bin/wrangler
  const localWrangler = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'wrangler.cmd')
  const isWin = process.platform === 'win32'

  if (isWin) {
    // Windows：通过 cmd /c 运行 .cmd 文件
    const cmdPath = existsSync(localWrangler) ? localWrangler : 'wrangler.cmd'
    return {
      command: 'cmd.exe',
      args: ['/d', '/c', cmdPath],
      useShell: false,
    }
  }

  // Unix：直接执行 wrangler
  const cmdPath = existsSync(localWrangler.replace('.cmd', ''))
    ? localWrangler.replace('.cmd', '')
    : 'wrangler'
  return {
    command: cmdPath,
    args: [],
    useShell: false,
  }
}

/**
 * 执行一次 wrangler kv:key put 命令
 * @param {string} namespaceId - KV namespace ID
 * @param {string} key - KV key 名称
 * @param {string} value - 值（直接传入，非文件路径）
 * @returns {Promise<{ success: boolean, output: string }>}
 */
function runKvPut(namespaceId, key, value) {
  const { command, args: cmdArgs } = resolveWranglerCommand()

  return new Promise((resolve) => {
    const child = execFile(
      command,
      [
        ...cmdArgs,
        'kv:key',
        'put',
        '--namespace-id', namespaceId,
        key,
        value,
      ],
      {
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || error.message || String(error)
          resolve({ success: false, output: message })
          return
        }
        resolve({ success: true, output: (stdout || '').trim() })
      }
    )
  })
}

/**
 * 从 provider 配置中提取路由映射（slug → pathPrefix）
 * @param {Array<object>} providers - provider 数组
 * @returns {string} JSON 字符串
 */
export function buildProviderRoutesJson(providers) {
  const routes = {}
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (p.pathPrefix && typeof p.pathPrefix === 'string') {
        // 必须用 gatewaySlug（custom- 前缀）作为键，与 worker 从 model id
        // 中解析出的 slug 以及 discover.js 写入 models.json 的前缀保持一致。
        // 用裸 id（如 fang-zhou）会导致 worker 查不到 pathPrefix，
        // 所有方舟请求回退到 /compat 端点。
        routes[gatewaySlug(p)] = p.pathPrefix
      }
    }
  }
  return JSON.stringify(routes)
}

/**
 * 仅将 provider 路由映射（provider-routes 键）写入 Cloudflare KV。
 *
 * provider 的 pathPrefix 变更后由 Web 管理端即时调用，保证 worker 路由
 * 与本地配置一致；不写 models 键，与模型列表部署解耦。
 * 未配置 namespaceId（本地开发 / 未初始化 KV）→ skipped，不报错。
 *
 * @param {object} config - loadConfig() 返回的配置对象
 * @param {object} [config.kv] - KV 配置
 * @param {string} [config.kv.namespaceId] - KV namespace ID
 * @param {Array<object>} [config.providers] - provider 数组（用于提取路由映射）
 * @returns {Promise<{ success: true, skipped?: boolean } | { success: false, output: string }>}
 */
export async function deployProviderRoutesToKV(config) {
  const namespaceId = config?.kv?.namespaceId
  if (!namespaceId) return { success: true, skipped: true }
  const routesJson = buildProviderRoutesJson(config.providers)
  return runKvPut(namespaceId, PROVIDER_ROUTES_KV_KEY, routesJson)
}

/**
 * 将 data/models.json 部署到 Cloudflare KV。
 * 同时写入 provider-routes 键（provider 路由映射）。
 * 使用 wrangler kv:key put 命令。
 *
 * @param {object} config - loadConfig() 返回的配置对象
 * @param {object} config.kv - KV 配置
 * @param {string} config.kv.namespaceId - KV namespace ID
 * @param {string} config.kv.key - KV key 名称（模型列表用）
 * @param {Array<object>} [config.providers] - provider 数组（用于提取路由映射）
 * @returns {Promise<{ success: boolean, output: string }>}
 */
export async function deployToKV(config) {
  // 检查 models.json 是否存在
  if (!existsSync(MODELS_JSON_PATH)) {
    return {
      success: false,
      output: `data/models.json 不存在：${MODELS_JSON_PATH}\n请先运行 generate 模块生成 models.json`,
    }
  }

  const { namespaceId, key } = config.kv

  if (!namespaceId) {
    return { success: false, output: '缺少 kv.namespaceId 配置' }
  }

  const { command, args: cmdArgs } = resolveWranglerCommand()

  // ─── 写入模型列表（用 --path 读文件） ───
  const modelsResult = await new Promise((resolve) => {
    const child = execFile(
      command,
      [
        ...cmdArgs,
        'kv:key',
        'put',
        '--namespace-id', namespaceId,
        key,
        '--path', MODELS_JSON_PATH,
      ],
      {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr || error.message || String(error)
          resolve({ success: false, output: message })
          return
        }
        resolve({ success: true, output: (stdout || '').trim() })
      }
    )
  })

  if (!modelsResult.success) {
    return modelsResult
  }

  // ─── 写入 provider 路由映射 ───
  const routesResult = await deployProviderRoutesToKV(config)

  if (!routesResult.success) {
    return {
      success: false,
      output: `模型列表已写入，但 provider 路由写入失败：${routesResult.output}`,
    }
  }

  return { success: true, output: modelsResult.output }
}
