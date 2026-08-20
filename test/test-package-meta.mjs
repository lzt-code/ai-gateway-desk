// 任务 17 验证脚本：npm 发布元数据断言
// 覆盖：private 移除 / bin 入口 / engines / files 白名单 / prepublishOnly / 发布元数据 / example 模板存在
// 不触网；任一失败打印清晰信息 + exit 1
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let failed = false
function check(name, ok, extra = '') {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` ${extra}`}`)
}

// ── 1. private 不是 true（undefined 或 false 均可，npm 才允许发布）
check('private 非 true', pkg.private !== true, `(实际 private=${JSON.stringify(pkg.private)})`)

// ── 2. bin 字段：命令名 + 入口路径
check('bin.aigd 路径正确', pkg.bin && pkg.bin['aigd'] === 'src/bin/aigd.js',
  `(实际 bin=${JSON.stringify(pkg.bin)})`)

// ── 3. bin 指向的文件存在且首行含 shebang
{
  const binPath = pkg.bin ? path.join(root, pkg.bin['aigd']) : ''
  const exists = binPath && fs.existsSync(binPath)
  const firstLine = exists ? fs.readFileSync(binPath, 'utf8').split('\n')[0].trim() : ''
  check('bin 文件存在', exists, `(路径 ${binPath})`)
  check('bin 文件首行 shebang', firstLine === '#!/usr/bin/env node', `(首行=${JSON.stringify(firstLine)})`)
}

// ── 4. engines.node 存在且主版本号 >= 18
{
  const nodeReq = pkg.engines && pkg.engines.node
  const major = nodeReq ? parseInt(String(nodeReq).replace(/[^\d]/g, ''), 10) : NaN
  check('engines.node 存在', typeof nodeReq === 'string' && nodeReq.length > 0, `(engines=${JSON.stringify(pkg.engines)})`)
  check('engines.node 主版本 >= 18', !Number.isNaN(major) && major >= 18, `(主版本=${major})`)
}

// ── 5. files 白名单：包含必需项
{
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const mustHave = [
    'src',
    'scripts',                          // Web UI 部署按钮 spawn scripts/deploy.mjs（npm 包内必须可用）
    'ai-gateway-desk-worker/src',       // Worker 源码（wrangler deploy 打包对象）
    'ai-gateway-desk-worker/wrangler.toml', // wrangler.toml 占位符模板（deploy.mjs 注入 KV id 用）
    'data/providers.example.json',
    'data/models.example.json',
  ]
  for (const f of mustHave) {
    check(`files 包含 ${f}`, files.includes(f), `(files=${JSON.stringify(files)})`)
  }
}

// ── 6. files 黑名单：不得打包的目录
{
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const mustNot = ['test', 'docs']
  for (const f of mustNot) {
    check(`files 不含 ${f}`, !files.includes(f), `(files=${JSON.stringify(files)})`)
  }
}

// ── 7. prepublishOnly === 'npm test'
check('prepublishOnly 为 npm test', pkg.scripts && pkg.scripts.prepublishOnly === 'npm test',
  `(实际=${JSON.stringify(pkg.scripts && pkg.scripts.prepublishOnly)})`)

// ── 8. 发布元数据：license / keywords 存在且非空；repository 待新仓库创建后补（2026-08-19 移除旧 URL）
check('license 存在', typeof pkg.license === 'string' && pkg.license.length > 0, `(license=${JSON.stringify(pkg.license)})`)
check('keywords 存在', Array.isArray(pkg.keywords) && pkg.keywords.length > 0, `(keywords=${JSON.stringify(pkg.keywords)})`)
check('repository 若设置则含有效 url', !pkg.repository || (pkg.repository && typeof pkg.repository.url === 'string' && pkg.repository.url.length > 0),
  `(repository=${JSON.stringify(pkg.repository)})`)

// ── 9. example 模板文件真实存在（config.js / generate.js 缺失提示依赖它们）
{
  for (const f of ['data/providers.example.json', 'data/models.example.json']) {
    const p = path.join(root, f)
    check(`${f} 存在`, fs.existsSync(p), `(路径 ${p})`)
  }
}

// ── 10. 发布字段完整性（防意外删除 type / 依赖）
check('type 为 module', pkg.type === 'module', `(type=${JSON.stringify(pkg.type)})`)
check('dependencies 不含 neo-blessed', !(pkg.dependencies && pkg.dependencies['neo-blessed']), `(dependencies=${JSON.stringify(pkg.dependencies)})`)
check('dependencies 含 hono', pkg.dependencies && typeof pkg.dependencies['hono'] === 'string', `(dependencies=${JSON.stringify(pkg.dependencies)})`)
check('dependencies 含 wrangler（部署 Worker/KV 必需，npm 安装须可见）',
  pkg.dependencies && typeof pkg.dependencies['wrangler'] === 'string',
  `(dependencies=${JSON.stringify(pkg.dependencies)})`)

// ── 11. 命令实际可运行（spawn 直接运行 bin，验证 shebang 链路 + isMain 直跑分支）
// 覆盖「全局安装后 aigd help 可用」的核心场景（不经 npm 包装器，避免环境差异）
{
  const { spawnSync } = await import('node:child_process')
  const binPath = pkg.bin ? path.join(root, pkg.bin['aigd']) : ''
  const res = spawnSync(process.execPath, [binPath, 'help'], { encoding: 'utf8' })
  check('bin help 可运行且退出码 0', res.status === 0, `(status=${res.status}, stderr=${String(res.stderr).slice(0, 80)})`)
  check('bin help 输出用法', res.stdout.includes('aigd') && res.stdout.includes('用法'), `(stdout=${JSON.stringify(String(res.stdout).slice(0, 60))})`)
}

console.log(`\n${failed ? '❌ 存在失败断言' : '✅ 全部通过'}`)
process.exit(failed ? 1 : 0)
