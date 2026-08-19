/**
 * 初始化向导（任务 11）
 * @module ai-gateway-desk/src/setup
 *
 * 职责：串接任务 10（cloudflare/api.js）+ 12（core/token-store.js 双凭证）
 *       + 14（cloudflare/providers-sync.js），实现「TUI 为主」方案的自动初始化：
 *   a. 管理 API Token → token-store 管理槽位
 *   b. Account ID（手工输入）
 *   c. 创建 AI Gateway
 *   d. 粘贴 cfut_xxx → token-store gateway 槽位 + 直接请求 gateway 端点验证
 *   e. Provider 配置（先拉云端列表，可跳过/复用/新建）→ 写 data/providers.json
 *   f. 创建 KV namespace → 回填 data/providers.json 的 kv.namespaceId（唯一数据源；
 *      不再写入 wrangler.toml——部署时由 scripts/deploy.mjs 动态注入临时配置）
 *   g. 汇总输出
 *
 * 说明：每步独立 try/catch，失败不中断后续，最后汇总报告。
 * 使用 readline/promises 交互，不引入 TUI 库。
 */

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createGateway,
  createCustomProvider,
  createKVNamespace,
  createProviderConfig,
} from './cloudflare/api.js'
import { fetchCloudProviders } from './cloudflare/providers-sync.js'
import {
  readManagementToken,
  readToken,
  writeManagementToken,
  writeToken,
  getSlotStatus,
} from './core/token-store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEFAULT_HOST = 'gateway.ai.cloudflare.com'
const DEFAULT_GATEWAY_ID = 'cf-ai-gateway'
const DEFAULT_KV_KEY = 'models'

/** src/ → 项目根 data/ */
function resolveData(...segments) {
  return path.resolve(__dirname, '..', 'data', ...segments)
}

// ─── 内部工具 ────────────────────────────────────────────

function maskToken(token) {
  if (!token) return '(未设置)'
  if (token.length <= 8) return '*'.repeat(token.length)
  return `${token.slice(0, 4)}${'*'.repeat(Math.max(4, token.length - 8))}${token.slice(-4)}`
}

// ─── 终端样式（ANSI 颜色，非 TTY 或 NO_COLOR 时自动禁用） ──
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (s) => (useColor ? `${code}${s}\x1b[0m` : s)
const style = {
  title: paint('\x1b[1;36m'), // 粗体亮青 — 向导/汇总标题
  step: paint('\x1b[1;33m'), // 粗体黄 — 步骤标题
  dim: paint('\x1b[2m'), // 暗灰 — 分割线 / 次要说明
  hl: paint('\x1b[1;32m'), // 粗体绿 — 重点标签
  url: paint('\x1b[4;34m'), // 下划线蓝 — URL
  ok: paint('\x1b[32m'), // 绿 — ✓ / 成功
  err: paint('\x1b[31m'), // 红 — ✗ / 失败
}

// ─── 步骤引导说明 ────────────────────────────────────────
// 每步开始直接打印说明（是什么 / 在哪获取 / 怎么操作），无需用户输入 ? 。
// 注意：步骤标题用「第 x/7 步」而非「[x/7]」，编号 [x/7] 只出现在提问 prompt，
//       避免 prompt 驱动测试在真正提问前误写入答案；
//       说明正文也不含「粘贴 cfut_xxx」「添加 Provider」等 prompt 关键字。

const LINE = '─'.repeat(58)

/** 打印步骤引导：分隔线 + 步骤标题 + 说明正文 */
function showGuide(title, lines) {
  console.log(style.dim(LINE))
  console.log(style.step(title))
  console.log(style.dim(LINE))
  for (const line of lines) console.log(line)
  console.log()
}

const G = {
  mgmt: [
    style.hl('【是什么】') + '账户级凭证，向导用它自动创建网关、保存厂商 Key、创建 KV、部署 Worker。',
    '权限很大，只保存在本机，绝不能分发给其他电脑。',
    '',
    style.hl('【在哪里创建】'),
    '  ① 打开 ' + style.url('https://dash.cloudflare.com/profile/api-tokens'),
    '  ② 点 "Create Token"（创建令牌）',
    '  ③ 推荐选模板 "Edit Cloudflare Workers"，再补充权限:',
    '     · Account → AI Gateway         → Edit / Read / Run',
    '     · Account → Workers Scripts    → Edit',
    '     · Account → Workers KV Storage → Edit',
    '  ④ 复制形如 AbCdEf123456 的令牌粘贴到下方',
    '     （令牌只在创建时显示一次，忘了就删除重建）',
  ],
  account: [
    style.hl('【是什么】') + '你的 Cloudflare 账号唯一标识（32 位十六进制串），',
    '用于定位 AI Gateway、KV 等资源。',
    '',
    style.hl('【在哪里查看】'),
    '  ① 登录 dashboard 后，地址栏 dash.cloudflare.com/<一长串就是它>',
    '  ② Workers & Pages → 任一 Worker → 右上角可直接复制',
  ],
  gateway: [
    style.hl('【是什么】') + '给 AI Gateway 起的名字，会出现在访问地址中:',
    '  ' + style.url('https://gateway.ai.cloudflare.com/v1/<账号ID>/<网关ID>/...'),
    '直接回车使用默认值 cf-ai-gateway 即可，一般无需修改。',
  ],
  cfut: [
    style.hl('【是什么】') + '绑定单个网关的认证 token，专用于「通过网关发请求」。',
    '  · 用途一：本地 TUI 模型发现（向网关拉取各 provider 的模型列表）',
    '  · 用途二：分发给各 PC 的 Agent —— Worker 转发推理请求时，网关用它验身份',
    '  · 它只管发请求，不做配置管理（建 gateway / 存 Key / 建 Provider 由管理 Token 负责）',
    '',
    style.hl('【权限怎么选】') + '勾选 ' + style.hl('Run') + ' 即可，不要勾 Edit —— 权限越小越安全。',
    '  该 token 会分发给各 PC，Run 泄露影响面仅限网关请求；配置管理由账户级管理 Token 承担。',
    'Cloudflare 不提供 API 创建，只能 dashboard 手工创建。',
    '',
    style.hl('【在哪里创建】'),
    '  ① 打开 ' + style.url('https://dash.cloudflare.com/<账号ID>/ai/ai-gateway/gateways/<网关ID>/settings'),
    '  ② 找到 Authentication 区块 → Create authentication token',
    '  ③ 权限勾选 Run → 生成并复制形如 cfut_xxxxxxxx 的字符串',
    '  ④ 粘贴 cfut_xxx 到下方输入框',
    '',
    style.hl('【验证失败怎么办】'),
    '  · 确认上一步网关创建成功（汇总里 Gateway 为 ✓）',
    '  · 确认是在该网关的设置页创建的',
    '  · 稍等几秒重试（云端创建可能未立即生效）',
  ],
  provider: [
    style.hl('[b] BYOK（自带 Key）') + ': 用你自己的厂商 API Key（OpenAI / Anthropic / DeepSeek 等），',
    '    网关把请求转发给厂商，费用和额度走你的厂商账号。',
    style.hl('[c] Custom Provider') + ': 接入任意自定义 base URL 的服务',
    '    （自建代理、中转、本地模型等），不需要厂商 Key。',
    '选完 [b]/[c] 后按提示填写即可，[q] 完成。',
  ],
  byok: [
    style.hl('【provider_slug】') + '厂商标识，如 openai / anthropic / deepseek / google，',
    '会出现在访问路径中: /v1/<账号>/<网关>/<slug>/chat/completions',
    '',
    style.hl('【厂商 API Key】') + '到厂商官网的 API Keys 页面创建并粘贴:',
    '  · OpenAI:    ' + style.url('https://platform.openai.com/api-keys'),
    '  · Anthropic: ' + style.url('https://console.anthropic.com/settings/keys'),
    '  · DeepSeek:  ' + style.url('https://platform.deepseek.com/api_keys'),
    'Key 会加密保存到 Cloudflare 云端，本机不落盘。',
  ],
  custom: [
    style.hl('【name】') + '     显示名称，如 "自建中转"。',
    style.hl('【slug】') + '     访问路径标识，如 custom-proxy（字母 / 数字 / 连字符）。',
    style.hl('【base URL】') + '  服务根地址，如 ' + style.url('https://proxy.example.com/v1'),
  ],
  kv: [
    '自动创建 KV namespace 存储模型列表，id 写入 data/providers.json（kv.namespaceId）。',
    '部署时由 npm run deploy 从 providers.json 动态注入 wrangler 配置，',
    'ai-gateway-desk-worker/wrangler.toml 始终保留占位符（不写入真实值，避免污染 git）。',
  ],
}

const BANNER = `
${style.title('════════════════════════════════════════════')}
${style.title(' Cloudflare AI Gateway 初始化向导（共 7 步）')}
${style.title('════════════════════════════════════════════')}
本向导自动完成：保存管理令牌 → 填账号标识 → 建网关 → 认证 token → Provider → KV。

${style.hl('你需要提前准备 2 样东西:')}
  ① 账户级管理令牌 —— dashboard 的 API Tokens 页创建（第 1 步引导你）
  ② 认证 token（cfut_xxx）—— 建好网关后在其设置页创建（第 4 步引导你）

${style.dim('某步失败不会中断，最后会汇总结果，可重新运行本向导重试。')}
`

/**
 * 读取一行输入（可带默认值，空回车用默认值）
 * @param {import('node:readline/promises').Interface} rl
 * @param {string} prompt
 * @param {string} [defaultValue]
 * @returns {Promise<string>}
 */
async function ask(rl, prompt, defaultValue = '') {
  const answer = await rl.question(prompt)
  return answer.trim() || defaultValue
}

/**
 * 直接请求 gateway 端点验证 cfut_xxx（不用 discoverModels——此时 providers.json 尚未写好）
 * 2xx 即验证通过；4xx/5xx（认证错误）与网络异常均视为失败
 * @param {string} host
 * @param {string} accountId
 * @param {string} gatewayId
 * @param {string} token - cfut_xxx
 * @returns {Promise<boolean>}
 */
export async function verifyGatewayToken(host, accountId, gatewayId, token) {
  const url = `https://${host}/v1/${accountId}/${gatewayId}/models`
  const res = await fetch(url, {
    headers: { 'cf-aig-authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  })
  return res.ok
}

// ─── 文件写入（纯函数，便于测试）────────────────────────

/**
 * 写入 data/providers.json（gateway / kv 保留本地已有值，仅 accountId/gatewayId 取向导输入）
 * @param {object} ctx - { host, accountId, gatewayId, providers: Array|null }
 *   providers 为 null 表示「跳过云端同步」→ 保留本地已有 providers 数组
 * @returns {string} 写入的文件路径
 */
export function writeProvidersFile(ctx) {
  const file = resolveData('providers.json')
  let existing = {}
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      // 损坏文件忽略，按全新环境处理
    }
  }
  const config = {
    gateway: {
      host: existing.gateway?.host || ctx.host || DEFAULT_HOST,
      accountId: ctx.accountId,
      gatewayId: ctx.gatewayId,
    },
    kv: {
      namespaceId: existing.kv?.namespaceId || '',
      key: existing.kv?.key || DEFAULT_KV_KEY,
    },
    providers:
      ctx.providers !== null && ctx.providers !== undefined
        ? ctx.providers
        : Array.isArray(existing.providers)
          ? existing.providers
          : [],
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return file
}

/**
 * 回填 data/providers.json 的 kv.namespaceId（唯一数据源）
 *
 * 2026-08-09 设计修正：不再写入 ai-gateway-desk-worker/wrangler.toml
 * （占位符文件被 git 跟踪，写入真实 id 会污染工作区且易误提交）；
 * 部署时由 scripts/deploy.mjs 从本文件动态注入临时 wrangler 配置。
 * @param {string} namespaceId
 */
export function backfillKVNamespaceId(namespaceId) {
  const file = resolveData('providers.json')
  let config = {}
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // 文件不存在/损坏 → 写最小结构
  }
  config.kv = config.kv || {}
  config.kv.namespaceId = namespaceId
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
}

// ─── Provider 新建流程 ───────────────────────────────────

/**
 * 交互式新建 Provider（BYOK 存厂商 Key / 建 Custom Provider），追加到 ctx.providers
 * @param {import('node:readline/promises').Interface} rl
 * @param {object} ctx
 */
async function addProviders(rl, ctx) {
  if (!Array.isArray(ctx.providers)) ctx.providers = []
  for (;;) {
    const choice = (await ask(rl, '  添加 Provider: [b]BYOK 厂商Key / [c]Custom Provider / [q]完成: ')).toLowerCase()
    if (choice === 'q' || choice === '') break

    if (choice === 'b') {
      console.log(style.dim(LINE))
      console.log(style.hl('【BYOK · 自带厂商 Key】'))
      for (const line of G.byok) console.log(line)
      console.log()
      const slug = await ask(rl, '    provider_slug (如 openai): ')
      const secret = await ask(rl, '    厂商 API Key: ')
      if (!slug || !secret) {
        console.log('  ✗ provider_slug / Key 不能为空')
        continue
      }
      if (ctx.providers.some((p) => p.id === slug)) {
        console.log(`  ⚠ ${slug} 已在 providers 列表中，跳过（避免重复 id 导致发现/合并异常）`)
        continue
      }
      const alias = (await ask(rl, '    alias [默认同 slug]: ')) || slug
      try {
        await createProviderConfig(ctx.apiToken, ctx.accountId, ctx.gatewayId, {
          providerSlug: slug,
          secret,
          alias,
        })
        ctx.providers.push({ id: slug, name: alias, enabled: true })
        console.log(`  ✓ BYOK ${slug} 已保存`)
      } catch (err) {
        console.log(`  ✗ 保存失败: ${err.message}`)
      }
    } else if (choice === 'c') {
      console.log(style.dim(LINE))
      console.log(style.hl('【Custom Provider · 自定义接入】'))
      for (const line of G.custom) console.log(line)
      console.log()
      const name = await ask(rl, '    名称 (name): ')
      const slug = await ask(rl, '    slug (如 custom-xxx): ')
      const baseUrl = await ask(rl, '    base URL: ')
      if (!name || !slug || !baseUrl) {
        console.log('  ✗ name / slug / baseUrl 不能为空')
        continue
      }
      if (ctx.providers.some((p) => p.id === slug)) {
        console.log(`  ⚠ ${slug} 已在 providers 列表中，跳过（避免重复 id 导致发现/合并异常）`)
        continue
      }
      try {
        await createCustomProvider(ctx.apiToken, ctx.accountId, { name, slug, baseUrl })
        ctx.providers.push({ id: slug, name, enabled: true })
        console.log(`  ✓ Custom Provider ${slug} 已创建`)
      } catch (err) {
        console.log(`  ✗ 创建失败: ${err.message}`)
      }
    } else {
      console.log('  无效选择')
    }
  }
}

// ─── 向导主流程 ──────────────────────────────────────────

/**
 * 初始化向导入口
 * @returns {Promise<void>}
 */
export async function runSetup() {
  const rl = createInterface({ input, output })
  const results = [] // 每步结果 { step, ok, message }
  const ctx = {
    host: DEFAULT_HOST,
    accountId: '',
    gatewayId: DEFAULT_GATEWAY_ID,
    apiToken: '',
    gateway: null,
    providers: [], // null = 跳过云端同步
    kv: null,
  }

  try {
    console.log(BANNER)

    // ─── a. 管理 API Token ───
    try {
      showGuide('第 1/7 步 · 管理 API Token', G.mgmt)
      const saved = readManagementToken()
      if (saved) {
        console.log(`[1/7] 管理 API Token: ${maskToken(saved)} (已保存)`)
        if ((await ask(rl, '  重新输入? (y/N): ')).toLowerCase() === 'y') {
          const token = await ask(rl, '  粘贴新 Token: ')
          if (token) {
            writeManagementToken(token)
            ctx.apiToken = token
          } else {
            ctx.apiToken = saved
          }
        } else {
          ctx.apiToken = saved
        }
      } else {
        const token = await ask(rl, '[1/7] 管理 API Token: ')
        if (!token) throw new Error('未输入 Token')
        writeManagementToken(token)
        ctx.apiToken = token
      }
      results.push({ step: '1. 管理 Token', ok: true, message: '已保存到本地安全存储' })
    } catch (err) {
      results.push({ step: '1. 管理 Token', ok: false, message: err.message })
    }

    // ─── b. Account ID（手工输入） ───
    try {
      showGuide('第 2/7 步 · Account ID', G.account)
      const accountId = await ask(rl, '[2/7] Account ID: ')
      if (!accountId) throw new Error('未输入 Account ID')
      ctx.accountId = accountId
      results.push({ step: '2. Account ID', ok: true, message: accountId })
    } catch (err) {
      results.push({ step: '2. Account ID', ok: false, message: err.message })
    }

    // ─── c. 创建 AI Gateway ───
    try {
      showGuide('第 3/7 步 · Gateway ID', G.gateway)
      ctx.gatewayId = await ask(rl, `[3/7] Gateway ID [${DEFAULT_GATEWAY_ID}]（回车用默认）: `, DEFAULT_GATEWAY_ID)
      if (!ctx.apiToken || !ctx.accountId) {
        throw new Error('缺少 apiToken / accountId，跳过创建')
      }
      ctx.gateway = await createGateway(ctx.apiToken, ctx.accountId, ctx.gatewayId)
      results.push({ step: '3. Gateway', ok: true, message: `创建/确认 ✓ (${ctx.gatewayId})` })
    } catch (err) {
      results.push({ step: '3. Gateway', ok: false, message: err.message })
    }

    // ─── d. cfut_xxx（dashboard 手工创建 + 粘贴 + 自动验证） ───
    try {
      showGuide('第 4/7 步 · 认证 token（cfut_xxx）', [
        ...G.cfut,
        '',
        style.hl('【你的专属入口】') + ' ' + style.url(
          `https://dash.cloudflare.com/${ctx.accountId || '<账号ID>'}/ai/ai-gateway/gateways/${ctx.gatewayId}/settings`
        ),
      ])
      const token = await ask(rl, '  粘贴 cfut_xxx（回车用已保存）: ')
      const effective = token || readToken() || ''
      if (!effective) throw new Error('未输入 cfut_xxx，跳过验证')
      if (token) writeToken(effective)
      const ok = await verifyGatewayToken(ctx.host, ctx.accountId, ctx.gatewayId, effective)
      if (!ok) throw new Error('认证验证失败（请确认 token 已创建且绑定该 gateway）')
      results.push({ step: '4. cfut_xxx', ok: true, message: '已保存并验证 ✓' })
    } catch (err) {
      results.push({ step: '4. cfut_xxx', ok: false, message: err.message })
    }

    // ─── e. Provider 配置（先拉云端列表，再决定） ───
    try {
      showGuide('第 5/7 步 · Provider 配置', G.provider)
      console.log('[5/7] 检测云端已有 Provider...')
      const cloud = await fetchCloudProviders(ctx.apiToken, ctx.accountId, ctx.gatewayId)
      for (const e of cloud.errors) {
        console.log(`  ⚠️ 云端拉取 ${e.source} 失败: ${e.error.message}`)
      }
      if (cloud.providers.length > 0) {
        console.log('  云端已有:')
        for (const p of cloud.providers) {
          console.log(`    - ${p.id} (${p.name}, ${p.type})`)
        }
        const choice = (await ask(rl, '  选择: [s]跳过 / [r]复用 / [n]新建 (默认 s): ', 's')).toLowerCase()
        if (choice === 'r') {
          ctx.providers = cloud.providers.map((p) => ({
            id: p.id,
            name: p.name,
            enabled: p.enabled !== false,
          }))
        } else if (choice === 'n') {
          await addProviders(rl, ctx)
        } else {
          ctx.providers = null // 跳过：保留本地已有 providers
        }
      } else {
        console.log('  云端无 provider，进入新建流程')
        await addProviders(rl, ctx)
      }
      const file = writeProvidersFile(ctx)
      results.push({
        step: '5. Provider',
        ok: true,
        message: `已写入 ${path.basename(file)}（${ctx.providers?.length ?? '保留本地'} 个）`,
      })
    } catch (err) {
      results.push({ step: '5. Provider', ok: false, message: err.message })
    }

    // ─── f. 创建 KV namespace + 回填 providers.json（唯一数据源） ───
    try {
      showGuide('第 6/7 步 · KV namespace', G.kv)
      if (!ctx.apiToken || !ctx.accountId) throw new Error('缺少 apiToken / accountId，跳过 KV 创建')
      ctx.kv = await createKVNamespace(ctx.apiToken, ctx.accountId, 'models-kv')
      backfillKVNamespaceId(ctx.kv.id)
      results.push({
        step: '6. KV namespace',
        ok: true,
        message: `${ctx.kv.id}（已回填 providers.json，部署时自动注入 wrangler 配置）`,
      })
    } catch (err) {
      results.push({ step: '6. KV namespace', ok: false, message: err.message })
    }

    // ─── g. 汇总 ───
    const slots = getSlotStatus()
    console.log('\n=== Setup 汇总 ===')
    console.log(`Account ID  : ${ctx.accountId || '(未设置)'}`)
    console.log(`Gateway     : ${ctx.gatewayId} @ ${ctx.host}（${ctx.gateway ? '✓' : '✗'}）`)
    console.log(`KV namespace: ${ctx.kv?.id || '(未创建)'}`)
    console.log(`凭证存储    : 管理=${slots.management} / gateway=${slots.gateway}`)
    console.log('\n各步骤结果:')
    for (const r of results) {
      console.log(`  [${r.ok ? '✓' : '✗'}] ${r.step}: ${r.message}`)
    }
    if (results.every((r) => r.ok)) {
      console.log('\n全部完成 ✓')
      console.log('下一步:')
      console.log('  1. 运行 npm run tui 进入 TUI 管理模型（发现 → 勾选 → 生成列表 → 部署）')
      console.log('  2. 把 cfut_xxx 分发给各 PC，配置到 Agent（如 Cline / Continue）即可走网关转发')
    } else {
      console.log('\n存在失败步骤（见上方 ✗ 项），可重新运行本向导重试：')
      console.log('  npm run aigd setup')
      console.log('  （已成功的步骤会自动跳过，不会重复执行）')
    }
  } finally {
    rl.close()
  }
}
