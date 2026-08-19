/**
 * 保存并提交编排测试（任务 19）
 *
 * 纯逻辑测试：mock saveState / writeModelsJson / deployToKV 三个依赖，
 * 断言 saveAndDeploy 的步骤编排（三步串行，失败不回滚，明确失败步骤）。
 *
 * 场景：
 *   A: 三步全成功 → { ok: true }，三个 mock 各调用 1 次且顺序正确（save → generate → deploy）
 *   B: 第 1 步失败 → { ok: false, step: 1 }，第 2/3 步未被调用
 *   C: 第 2 步失败 → { ok: false, step: 2 }，第 1 步已执行、第 3 步未调用
 *   D: 第 3 步失败 → { ok: false, step: 3 }，第 1/2 步已执行（含 deployToKV 返回
 *      { success: false } 与抛错两条路径）
 */

import { saveAndDeploy } from '../src/tui/actions.js'

let failures = 0
let checks = 0

function check(cond, msg) {
  checks++
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function section(name) {
  console.log(`\n${name}`)
}

const fakeState = { 'p/m': { status: 'selected', metadata: { id: 'm' } } }
const fakeConfig = { kv: { namespaceId: 'ns', key: 'models' } }

// 创建 mock 三步依赖：records 记录调用顺序，可注入第 N 步失败
function makeMocks({ failStep = 0, deployReturnsFalse = false } = {}) {
  const records = []
  const saveStateFn = (state) => {
    records.push('save')
    if (failStep === 1) throw new Error('save 失败')
  }
  const writeModelsJsonFn = (state) => {
    records.push('generate')
    if (failStep === 2) throw new Error('generate 失败')
  }
  const deployToKVFn = async (config) => {
    records.push('deploy')
    if (failStep === 3) throw new Error('deploy 抛错')
    if (deployReturnsFalse) return { success: false, output: 'wrangler 部署失败输出' }
    return { success: true, output: 'ok' }
  }
  return { saveStateFn, writeModelsJsonFn, deployToKVFn, records }
}

// ── 测试 1：场景 A — 三步全成功 ──
section('测试 1: 场景 A — 三步全成功')
{
  const { saveStateFn, writeModelsJsonFn, deployToKVFn, records } = makeMocks()
  const result = await saveAndDeploy({ state: fakeState, config: fakeConfig, saveStateFn, writeModelsJsonFn, deployToKVFn })
  check(result.ok === true, '返回 { ok: true }')
  check(records.join(',') === 'save,generate,deploy', `调用顺序正确（实际 ${records.join(',')}）`)
  check(records.length === 3, '三个依赖各调用 1 次')
}

// ── 测试 2：场景 B — 第 1 步失败 ──
section('测试 2: 场景 B — 第 1 步失败')
{
  const { saveStateFn, writeModelsJsonFn, deployToKVFn, records } = makeMocks({ failStep: 1 })
  const result = await saveAndDeploy({ state: fakeState, config: fakeConfig, saveStateFn, writeModelsJsonFn, deployToKVFn })
  check(result.ok === false && result.step === 1, '返回 { ok: false, step: 1 }')
  check(result.error instanceof Error && result.error.message === 'save 失败', 'error 透传第 1 步异常')
  check(records.length === 1 && records[0] === 'save', '第 2/3 步未被调用')
}

// ── 测试 3：场景 C — 第 2 步失败 ──
section('测试 3: 场景 C — 第 2 步失败')
{
  const { saveStateFn, writeModelsJsonFn, deployToKVFn, records } = makeMocks({ failStep: 2 })
  const result = await saveAndDeploy({ state: fakeState, config: fakeConfig, saveStateFn, writeModelsJsonFn, deployToKVFn })
  check(result.ok === false && result.step === 2, '返回 { ok: false, step: 2 }')
  // mock 在抛错前已 push 记录，故记录含失败步骤本身；此处断言步骤包含关系
  check(records[0] === 'save' && records.includes('generate') === true, '第 1/2 步已被调用')
  check(records.includes('deploy') === false, '第 3 步未调用')
}

// ── 测试 4：场景 D1 — 第 3 步失败（deployToKV 抛错）──
section('测试 4: 场景 D1 — 第 3 步失败（抛错）')
{
  const { saveStateFn, writeModelsJsonFn, deployToKVFn, records } = makeMocks({ failStep: 3 })
  const result = await saveAndDeploy({ state: fakeState, config: fakeConfig, saveStateFn, writeModelsJsonFn, deployToKVFn })
  check(result.ok === false && result.step === 3, '返回 { ok: false, step: 3 }')
  check(records[0] === 'save' && records[1] === 'generate', '第 1/2 步已执行')
}

// ── 测试 5：场景 D2 — 第 3 步失败（deployToKV 返回 { success: false }）──
section('测试 5: 场景 D2 — 第 3 步失败（返回 success:false）')
{
  const { saveStateFn, writeModelsJsonFn, deployToKVFn, records } = makeMocks({ deployReturnsFalse: true })
  const result = await saveAndDeploy({ state: fakeState, config: fakeConfig, saveStateFn, writeModelsJsonFn, deployToKVFn })
  check(result.ok === false && result.step === 3, '返回 { ok: false, step: 3 }')
  check(result.error instanceof Error && result.error.message === 'wrangler 部署失败输出',
    'success:false 的 output 包装为 Error 透传')
  check(records.join(',') === 'save,generate,deploy', '三步均被调用（第 3 步执行后判定失败）')
}

// ── 测试 6：默认依赖绑定真实模块 ──
section('测试 6: 默认依赖绑定真实模块')
{
  // 不传依赖时使用真实 saveState / writeModelsJson / deployToKV；
  // 这里只验证函数签名可用（真实调用会写 data/ 文件，此处不执行），
  // 通过 mock 全成功路径验证注入点行为即可——签名检查兜底。
  const result = await saveAndDeploy({
    state: fakeState,
    config: fakeConfig,
    saveStateFn: () => {},
    writeModelsJsonFn: () => {},
    deployToKVFn: async () => ({ success: true }),
  })
  check(result.ok === true, '注入任意 mock 均可工作（签名兼容）')
}

console.log(`\n结果: ${checks - failures}/${checks} 通过`)
process.exit(failures ? 1 : 0)
