/**
 * 动态路由流程图（elements）本地校验 — 纯函数，无 IO 无依赖。
 *
 * 校验目标：在 POST versions 提交前拦截明显错误的图，避免无效版本上传。
 * 规则与 Cloudflare Dynamic Routing JSON Configuration 对齐：
 *   start / conditional / percentage / model / rate / end 六种节点，
 *   outputs.{输出名}.elementId 连线；percentage 各输出键（如 "10%"）为概率权重。
 *
 * @module ai-gateway-desk/src/pipeline/routes-validate
 */

const KNOWN_TYPES = new Set(['start', 'conditional', 'percentage', 'model', 'rate', 'end'])

/** 每种节点类型的合法输出端口（超出视为拼写错误，防御连线悬挂） */
const KNOWN_OUTPUTS = {
  start: ['next'],
  conditional: ['true', 'false'],
  percentage: null, // 动态："10%" / "40%" 等权重键
  model: ['success', 'fallback'],
  rate: ['success', 'fallback'],
  end: [],
}

/**
 * 校验单条路由的 elements 图
 * @param {Array<object>} elements - 流程图节点数组
 * @returns {{ ok: boolean, errors: string[] }} errors 为中文可读错误列表（空数组 = 通过）
 */
export function validateRouteElements(elements) {
  const errors = []
  if (!Array.isArray(elements) || elements.length === 0) {
    return { ok: false, errors: ['elements 必须是非空数组'] }
  }

  // ── 基础结构：id / type / 唯一性 ──
  const byId = new Map()
  for (const [i, el] of elements.entries()) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) {
      errors.push(`节点 #${i + 1}：必须是对象`)
      continue
    }
    if (typeof el.id !== 'string' || !el.id.trim()) {
      errors.push(`节点 #${i + 1}：缺少 id`)
      continue
    }
    if (byId.has(el.id)) {
      errors.push(`节点 id 重复：${el.id}`)
      continue
    }
    if (typeof el.type !== 'string' || !KNOWN_TYPES.has(el.type)) {
      errors.push(`节点 ${el.id}：未知类型 ${JSON.stringify(el.type)}（合法值：start/conditional/percentage/model/rate/end）`)
      continue
    }
    byId.set(el.id, el)
  }

  const nodes = [...byId.values()]

  // ── start / end 约束 ──
  const starts = nodes.filter((n) => n.type === 'start')
  if (starts.length !== 1) {
    errors.push(`start 节点必须有且仅有一个（当前 ${starts.length} 个）`)
  }
  const ends = nodes.filter((n) => n.type === 'end')
  if (ends.length === 0) {
    errors.push('缺少 end 节点（流程必须终止于 end）')
  }

  // ── 逐节点检查 properties 与 outputs ──
  for (const el of nodes) {
    const { id, type } = el

    if (type === 'end') {
      // end 无输出端口（官方约定 outputs 为空对象）；带多余输出视为拼写错误
      const outputs = el.outputs
      if (outputs && typeof outputs === 'object' && !Array.isArray(outputs) && Object.keys(outputs).length > 0) {
        errors.push(`节点 ${id}：end 不应带输出端口（outputs 应为空对象）`)
      }
    } else {
      const outputs = el.outputs
      if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
        errors.push(`节点 ${id}：${type} 缺少 outputs（连线表）`)
        continue
      }
      const allowed = KNOWN_OUTPUTS[type]
      for (const [port, target] of Object.entries(outputs)) {
        if (Array.isArray(allowed) && !allowed.includes(port)) {
          errors.push(`节点 ${id}：${type} 不支持输出端口 "${port}"（合法值：${allowed.join(', ')}）`)
        }
        if (!target || typeof target !== 'object' || typeof target.elementId !== 'string' || !target.elementId.trim()) {
          errors.push(`节点 ${id}：输出 "${port}" 缺少 elementId`)
          continue
        }
        if (!byId.has(target.elementId)) {
          errors.push(`节点 ${id}：输出 "${port}" 指向不存在的节点 ${target.elementId}`)
        }
      }
    }

    if (type === 'model') {
      const p = el.properties || {}
      if (typeof p.provider !== 'string' || !p.provider.trim()) {
        errors.push(`节点 ${id}：model 节点缺少 properties.provider`)
      }
      if (typeof p.model !== 'string' || !p.model.trim()) {
        errors.push(`节点 ${id}：model 节点缺少 properties.model`)
      }
      if (p.timeout !== undefined && !Number.isFinite(p.timeout)) {
        errors.push(`节点 ${id}：timeout 必须是数字（毫秒）`)
      }
      if (p.retries !== undefined && !Number.isInteger(p.retries)) {
        errors.push(`节点 ${id}：retries 必须是整数`)
      }
      // Cloudflare 现行校验（实测 2026-09-08）：model 节点 outputs 必须同时含 success 与 fallback
      // 缺 fallback 直接 7001 Required at body.elements[n].outputs.fallback
      const mOutputs = el.outputs || {}
      if (!mOutputs.success || typeof mOutputs.success.elementId !== 'string' || !mOutputs.success.elementId.trim()) {
        errors.push(`节点 ${id}：model 节点缺少 outputs.success`)
      }
      if (!mOutputs.fallback || typeof mOutputs.fallback.elementId !== 'string' || !mOutputs.fallback.elementId.trim()) {
        errors.push(`节点 ${id}：model 节点缺少 outputs.fallback（cloud 7001，末级也需 fallback→END）`)
      }
    }

    if (type === 'rate') {
      const p = el.properties || {}
      if (p.limitType !== 'count' && p.limitType !== 'cost') {
        errors.push(`节点 ${id}：limitType 必须是 count 或 cost`)
      }
      if (!Number.isFinite(p.limit) || p.limit <= 0) {
        errors.push(`节点 ${id}：limit 必须是正数`)
      }
      if (!Number.isFinite(p.window) || p.window <= 0) {
        errors.push(`节点 ${id}：window 必须是正数（秒）`)
      }
      if (typeof p.key !== 'string' || !p.key.trim()) {
        errors.push(`节点 ${id}：rate 节点缺少 properties.key（限流维度字段，如 metadata.user_id）`)
      }
    }

    if (type === 'conditional') {
      const p = el.properties || {}
      if (!p.conditions || typeof p.conditions !== 'object' || Array.isArray(p.conditions) || Object.keys(p.conditions).length === 0) {
        errors.push(`节点 ${id}：conditional 节点缺少 properties.conditions（条件表达式）`)
      }
    }

    if (type === 'percentage') {
      const outputs = el.outputs || {}
      const weightKeys = Object.keys(outputs)
      if (weightKeys.length === 0) {
        errors.push(`节点 ${id}：percentage 节点缺少概率输出（如 "50%"）`)
      }
      let sum = 0
      let allWeightsValid = true
      for (const k of weightKeys) {
        const w = parseFloat(k)
        if (!Number.isFinite(w)) {
          errors.push(`节点 ${id}：percentage 输出键 "${k}" 不是合法权重（应为 "10%" 形式）`)
          allWeightsValid = false
          continue
        }
        sum += w
      }
      if (allWeightsValid && weightKeys.length > 0 && Math.abs(sum - 100) > 1e-9) {
        errors.push(`节点 ${id}：percentage 权重之和必须为 100（当前 ${sum}）`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}
