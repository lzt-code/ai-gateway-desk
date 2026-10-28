/**
 * 回归验证：初始化全局阻塞解锁不应把按钮重新禁用
 *
 * 场景（「添加 Provider」长期灰色不可点）：
 *  1. Provider 视图渲染时先把 #btn-provider-add 占位禁用（disabled=true）
 *  2. 初始化阻塞 setInitOperationButtonsDisabled(true) 把当前态当基准快照记下
 *  3. 云端响应到达，视图按只读态重设按钮（disabled=false）
 *  4. 解锁时若直接用「锁定前快照」还原，按钮被重新禁用并且再无逻辑恢复 → 永久灰色
 *
 * 断言：解锁时若按钮在锁定期间被显式重新启用，则以新状态为准；无人改动时仍按快照还原。
 *
 * 无真实 DOM：用最小 document 桩覆盖 setInitOperationButtonsDisabled 的取值路径。
 */

const { setInitOperationButtonsDisabled } = await import('../src/web/public/app.js')

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

// ── 最小 DOM 桩 ──────────────────────────────────────────
function makeBtn(disabled) {
  return {
    tagName: 'BUTTON',
    disabled,
    dataset: {},
    style: {},
    setAttribute() {},
    removeAttribute() {},
  }
}

function installDom(buttons) {
  const sideActions = { querySelectorAll: (sel) => (sel === 'button' ? buttons : []) }
  const bodyClass = new Set()
  globalThis.document = {
    body: {
      classList: {
        add: (c) => bodyClass.add(c),
        remove: (c) => bodyClass.delete(c),
      },
    },
    querySelector: (sel) => (sel === '#side-actions' ? sideActions : null),
  }
  return { bodyClass }
}

function runCase({ before, during, after, title }) {
  const btn = makeBtn(before)
  const { bodyClass } = installDom([btn])
  setInitOperationButtonsDisabled(true)
  check(btn.disabled === true, `${title}：锁定期间按钮被禁用`)
  check(bodyClass.has('init-blocking'), `${title}：body 带 init-blocking 类`)
  if (during !== null) btn.disabled = during
  setInitOperationButtonsDisabled(false)
  check(btn.disabled === after, `${title}：解锁后 disabled === ${after}`)
  check(!bodyClass.has('init-blocking'), `${title}：body 移除 init-blocking 类`)
  check(btn.dataset.initLock === undefined, `${title}：解锁后清理 initLock 标记`)
}

section('setInitOperationButtonsDisabled —— 解锁态还原')
// 1：锁定前启用、期间无人改动 → 还原为启用（既有行为）
runCase({ before: false, during: null, after: false, title: '锁定前启用 / 期间无改动' })
// 2：锁定前禁用（渲染占位）、期间按只读态重新启用 → 尊重新状态（回归用例）
runCase({ before: true, during: false, after: false, title: '锁定前禁用 / 期间重新启用' })
// 3：锁定前禁用、期间无改动 → 仍为禁用（只读模式）
runCase({ before: true, during: null, after: true, title: '锁定前禁用 / 期间无改动' })

// 4：真实启动序列——锁定期间 refreshProviders 会再次调用 setInitOperationButtonsDisabled(true)，
//    已锁按钮被跳过（不覆盖快照）；随后视图按只读态启用，解锁后必须保持启用
{
  const btn = makeBtn(true) // 视图渲染占位禁用
  const { bodyClass } = installDom([btn])
  setInitOperationButtonsDisabled(true) // 初始化阻塞
  setInitOperationButtonsDisabled(true) // 本地快照 / 云端响应后重复加锁
  btn.disabled = false                 // applyReadonlyUI：readonly=false → 启用
  setInitOperationButtonsDisabled(true) // 响应后再次加锁（仍跳过）
  setInitOperationButtonsDisabled(false)
  check(btn.disabled === false, '启动时序（重复加锁 + 只读态启用）：解锁后按钮可点')
  check(!bodyClass.has('init-blocking'), '启动时序（重复加锁 + 只读态启用）：body 移除 init-blocking 类')
}

delete globalThis.document

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${checks - failures}/${checks} 断言`)
if (failures > 0) {
  console.log(`\n✗ ${failures} 个断言失败`)
  process.exit(1)
}
console.log('全部通过 ✓')
