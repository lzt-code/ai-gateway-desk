/**
 * 聚合测试入口 — 依次运行 test/ 下全部测试脚本
 *
 * 用法：node test/run-all.mjs（npm test 已指向本文件）
 * 任一测试失败 → 退出码 1
 *
 * 说明：各测试文件均为独立脚本（各自 process.exit），无法直接 import，
 * 故用子进程串行执行，输出原样透传（stdio: 'inherit'）。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 运行顺序：各测试相互独立，保持稳定顺序
const TESTS = [
  'test-merge.mjs',             // 模型合并：策略 A 覆盖 + 未发现→物理删除（manual 豁免）
  'test-model-filter.mjs',      // 任务 19：模型筛选纯函数（provider / 关键字 / 组合）
  'test-model-table.mjs',       // 任务 24：模型表格 + Provider 侧栏 + F2 筛选范围（纯函数）
  'test-save-deploy.mjs',       // 任务 19：保存并提交三步编排（mock 依赖）
  'test-provider-sync-logic.mjs', // 任务 15：syncProvidersToConfig 纯函数（原 test-tui-provider-sync.mjs）
  'test-discover-progress.mjs', // discoverModels 进度回调（mock fetch）
  'test-deploy-config.mjs',     // scripts/deploy.mjs 动态注入占位符（纯函数）
  'test-provider-routes.mjs',   // provider-routes KV 键与 gatewaySlug 一致（回归方舟 compat 回退 bug）
  'test-token-store.mjs',       // 任务 12：双凭证槽位（自动备份/恢复真实凭证）
  'test-providers-sync.mjs',    // 任务 14：mergeProviders 纯逻辑
  'test-provider-view.mjs',     // 任务 20：Provider 视图纯函数 + api update 端点 + 列表项
  'test-account-view.mjs',      // 任务 21：Worker/账户视图纯函数（token 状态汇总 + 编排 + 渲染）
  'test-setup.mjs',             // 任务 11：setup 纯函数 + 假 token 全流程
  'test-worker-config.mjs',     // 任务 13：Worker 配置 env 化
  'test-package-meta.mjs',      // 任务 17：npm 发布元数据断言
  'test-web-server.mjs',        // 任务 25：Web 服务器基础（Hono + 静态文件 + 启动器）
  'test-web-api-models.mjs',    // 任务 26：模型管理 API 端点（内存 stateStore 注入）
  'test-web-api-sync.mjs',      // 任务 27：同步 + 保存部署 API（SSE 进度 + 编排 mock）
  'test-web-api-providers.mjs', // 任务 28：Provider 管理 API（云端合并 + 编辑 + 删除，全 mock）
  'test-web-api-account.mjs',   // 任务 29：Worker + 账户管理 API（状态 + 部署 + Token，全 mock）
  'test-web-frontend.mjs',      // 任务 30：前端骨架（结构断言 + app.js 纯函数单测）
  'test-web-models-view.mjs',   // 任务 31：前端模型视图纯函数（表格行/SSE 解析/进度状态/筛选/dirty）
  'test-web-providers-view.mjs', // 任务 32：前端 Provider 视图纯函数（行/字段/变更组装）
  'test-web-account-view.mjs',  // 任务 33：前端 Worker + 账户视图纯函数（状态面板/槽位卡渲染）
  'test-provider-create.mjs',   // 添加 Provider FP1：云端创建纯逻辑层（校验 + 分发，全 mock）
  'test-web-api-provider-create.mjs', // 添加 Provider FP2：POST /api/providers/create 端点（全 mock）
  'test-web-provider-add-view.mjs',   // 添加 Provider FP4：前端添加视图纯函数（字段/载荷校验/结果日志）
  'test-web-sorting.mjs',             // 表格列排序：sortViewItems/nextSortState/两表取值器（纯函数）
  'test-web-dynamic-routes-link.mjs', // 动态路由入口：buildCfDynamicRoutesUrl 纯函数（外链构建/回退/转义）
  'test-dynamic-routes-view.mjs',     // 动态路由视图：链归一化 + collectDynamicRoutes + tab 骨架契约
]

const results = []
for (const name of TESTS) {
  const file = path.join(__dirname, name)
  process.stdout.write(`\n${'='.repeat(56)}\n▶ 运行 ${name}\n${'='.repeat(56)}\n`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    child.on('close', resolve)
    child.on('error', (err) => {
      console.error(`  无法启动子进程: ${err.message}`)
      resolve(1)
    })
  })
  results.push({ name, ok: code === 0 })
}

console.log(`\n${'='.repeat(56)}`)
console.log('测试汇总')
for (const { name, ok } of results) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
}
const failed = results.filter((r) => !r.ok)
console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
process.exit(failed.length ? 1 : 0)
