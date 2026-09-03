// 双源富化（OpenRouter + models.dev）测试
// 覆盖：双源融合补缺、name 优先级、匹配优先级 a/b/c/d、已有字段不覆盖、
//       fetch 失败静默降级、模块级缓存（_resetCache）
import { enrichModel, _resetCache } from '../src/pipeline/enrich.js'

let failed = false
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (期望 ${JSON.stringify(expected)})`}`)
}
function checkTrue(name, cond) {
  const ok = !!cond
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// mock fetch：按 URL 路由到 OpenRouter 或 models.dev，由全局变量控制当前场景数据
let mockOR = null // null 表示该源失败（500）
let mockMD = null
let orCallCount = 0
let mdCallCount = 0
const originalFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const s = String(url)
  if (s.includes('openrouter.ai')) {
    orCallCount++
    if (!mockOR) return new Response('{}', { status: 500, statusText: 'Server Error' })
    return new Response(JSON.stringify({ data: mockOR }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (s.includes('models.dev')) {
    mdCallCount++
    if (!mockMD) return new Response('err', { status: 500, statusText: 'Server Error' })
    return new Response(JSON.stringify(mockMD), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('not found', { status: 404 })
}

// ── mock 数据 ──
// OpenRouter：glm-5.2（无 max_output_length/top_provider，留给 MD 补）；gpt-4o（全字段）
const OR_DATA = [
  {
    id: 'z-ai/glm-5.2',
    name: 'Z.ai: GLM 5.2',
    context_length: 128000,
    // 故意不提供 max_output_length / top_provider，让 MD 补
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      modality: 'text+image->text',
    },
    supported_parameters: ['tools', 'response_format', 'temperature', 'top_p'],
  },
  {
    id: 'openai/gpt-4o',
    name: 'OpenAI: GPT-4o',
    context_length: 128000,
    max_output_length: 16384,
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
    supported_parameters: ['tools', 'response_format'],
  },
]

// models.dev：glm-5.2（MD 有 max_output）；claude-opus-5（OR 无，测 MD 单源）；gpt-4o（modalities 多 audio）
const MD_CATALOG = {
  providers: {
    zhipuai: {
      id: 'zhipuai',
      name: 'Zhipu AI',
      npm: '@ai-sdk/openai-compatible',
      api: 'https://open.bigmodel.cn/api/paas/v4',
      doc: 'https://docs.z.ai',
      env: ['ZHIPUAI_API_KEY'],
      models: {
        'glm-5.2': {
          id: 'glm-5.2',
          name: 'GLM 5.2',
          description: 'Zhipu GLM 5.2',
          reasoning: true,
          tool_call: true,
          structured_output: true,
          temperature: true,
          attachment: true,
          open_weights: true,
          release_date: '2026-06-13',
          last_updated: '2026-06-13',
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1000000, output: 131072 },
        },
      },
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      npm: '@ai-sdk/anthropic',
      doc: 'https://docs.anthropic.com',
      env: ['ANTHROPIC_API_KEY'],
      models: {
        'claude-opus-5': {
          id: 'claude-opus-5',
          name: 'Claude Opus 5',
          description: 'Claude Opus 5',
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          attachment: true,
          open_weights: false,
          release_date: '2026-07-24',
          last_updated: '2026-07-24',
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 1000000, output: 128000 },
        },
      },
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      npm: '@ai-sdk/openai',
      doc: 'https://platform.openai.com',
      env: ['OPENAI_API_KEY'],
      models: {
        'gpt-4o': {
          id: 'gpt-4o',
          name: 'GPT-4o',
          description: 'GPT-4o',
          reasoning: false,
          tool_call: true,
          structured_output: true,
          temperature: true,
          attachment: true,
          open_weights: false,
          release_date: '2024-05-13',
          last_updated: '2024-05-13',
          modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
          limit: { context: 128000, output: 16384 },
        },
      },
    },
  },
  models: {
    'zhipuai/glm-5.2': {
      id: 'zhipuai/glm-5.2',
      name: 'GLM 5.2',
      description: 'Zhipu GLM 5.2',
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: true,
      release_date: '2026-06-13',
      last_updated: '2026-06-13',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1000000, output: 131072 },
    },
    'anthropic/claude-opus-5': {
      id: 'anthropic/claude-opus-5',
      name: 'Claude Opus 5',
      description: 'Claude Opus 5',
      reasoning: false,
      tool_call: true,
      structured_output: true,
      temperature: true,
      release_date: '2026-07-24',
      last_updated: '2026-07-24',
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      limit: { context: 1000000, output: 128000 },
    },
    'openai/gpt-4o': {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      description: 'GPT-4o',
      reasoning: false,
      tool_call: true,
      structured_output: true,
      temperature: true,
      release_date: '2024-05-13',
      last_updated: '2024-05-13',
      modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
      // metadata 的 limit.output 可选，故意不提供，验证 provider model 兜底
      limit: { context: 128000 },
    },
  },
}

try {
  // ── 场景 1：OR 匹配 + MD 补缺（max_output_length OR 无、MD 补 131072）──
  _resetCache()
  mockOR = OR_DATA
  mockMD = MD_CATALOG
  orCallCount = mdCallCount = 0
  {
    const r = await enrichModel('custom-glm/glm-5.2', { id: 'custom-glm/glm-5.2' })
    // name 由 OR 补全（input 无 name，fill-only 语义）
    check('场景1 name=OR补全', r.name, 'Z.ai: GLM 5.2')
    // context_length OR 提供 128000
    check('场景1 context_length=OR', r.context_length, 128000)
    // max_output_length OR 缺失 → MD 补 131072
    check('场景1 max_output_length=MD补', r.max_output_length, 131072)
    // input_modalities OR 提供
    check('场景1 input_modalities=OR', r.input_modalities, ['text', 'image'])
    // supported_sampling_parameters OR 提供
    check('场景1 sampling=OR', r.supported_sampling_parameters, ['tools', 'response_format', 'temperature', 'top_p'])
    // supported_features OR 推断（tools + response_format→json_mode）
    check('场景1 features=OR推断', r.supported_features, ['tools', 'json_mode'])
  }

  // ── 场景 2：OR 无匹配 + MD 全量补（claude-opus-5，OR 数据里没有）──
  _resetCache()
  mockOR = OR_DATA
  mockMD = MD_CATALOG
  {
    const r = await enrichModel('custom-anthropic/claude-opus-5', { id: 'custom-anthropic/claude-opus-5' })
    // name 由 MD 补（OR 未匹配，result.name undefined → MD 补 "Claude Opus 5"）
    check('场景2 name=MD补', r.name, 'Claude Opus 5')
    check('场景2 context_length=MD', r.context_length, 1000000)
    check('场景2 max_output_length=MD', r.max_output_length, 128000)
    check('场景2 input_modalities=MD', r.input_modalities, ['text', 'image', 'pdf'])
    check('场景2 output_modalities=MD', r.output_modalities, ['text'])
    // MD 推断 sampling：tool_call→tools；structured_output→response_format,json_schema；temperature→temperature,top_p
    check('场景2 sampling=MD推断', r.supported_sampling_parameters, ['tools', 'response_format', 'json_schema', 'temperature', 'top_p'])
    // MD 推断 features：tool_call→tools；structured_output→json_mode（reasoning=false 不加）
    check('场景2 features=MD推断', r.supported_features, ['tools', 'json_mode'])
  }

  // ── 场景 3：provider model id 匹配（c 规则，catalog.models 无但 providers 有）──
  _resetCache()
  mockOR = null // OR 失败
  mockMD = {
    providers: {
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.deepseek.com',
        doc: 'https://api-docs.deepseek.com',
        env: ['DEEPSEEK_API_KEY'],
        models: {
          'deepseek-v4': {
            id: 'deepseek-v4',
            name: 'DeepSeek V4',
            description: 'DeepSeek V4',
            reasoning: true,
            tool_call: true,
            structured_output: true,
            temperature: true,
            attachment: false,
            open_weights: true,
            release_date: '2026-08-12',
            last_updated: '2026-08-22',
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 1000000, output: 384000 },
          },
        },
      },
    },
    models: {}, // 空：a/b/d 都不触发，走 c
  }
  {
    const r = await enrichModel('custom-ds/deepseek-v4', { id: 'custom-ds/deepseek-v4' })
    // c 规则：provider model.id === shortId 匹配
    check('场景3 name=providerModel', r.name, 'DeepSeek V4')
    check('场景3 context_length', r.context_length, 1000000)
    check('场景3 max_output_length', r.max_output_length, 384000)
    check('场景3 input_modalities', r.input_modalities, ['text'])
    check('场景3 output_modalities', r.output_modalities, ['text'])
    // reasoning=true → features 含 reasoning
    check('场景3 features', r.supported_features, ['reasoning', 'tools', 'json_mode'])
  }

  // ── 场景 4：name 模糊匹配（d 规则，a/b/c 都不命中）──
  _resetCache()
  mockOR = null
  mockMD = MD_CATALOG
  {
    // modelId 短名 "my-gpt-4o" → namePart "my gpt 4o"；MD name "GPT-4o" → "gpt 4o"
    // "my gpt 4o".includes("gpt 4o") → true，d 规则匹配
    const r = await enrichModel('custom-x/my-gpt-4o', { id: 'custom-x/my-gpt-4o' })
    check('场景4 name=MD模糊匹配', r.name, 'GPT-4o')
    check('场景4 context_length', r.context_length, 128000)
    // provider model gpt-4o 的 limit.output=16384
    check('场景4 max_output_length', r.max_output_length, 16384)
  }

  // ── 场景 5：已有字段不被覆盖（context_length 用户已填，name 也不覆盖）──
  _resetCache()
  mockOR = OR_DATA
  mockMD = MD_CATALOG
  {
    const r = await enrichModel('custom-glm/glm-5.2', {
      id: 'custom-glm/glm-5.2',
      context_length: 999, // 用户已填，不应被覆盖
      name: '我的自定义名', // name 也遵循 fill-only，已有的不被覆盖
    })
    check('场景5 context_length不覆盖', r.context_length, 999)
    check('场景5 name不覆盖（fill-only）', r.name, '我的自定义名')
  }

  // ── 场景 6：双源都失败，返回原 metadata（不抛错）──
  _resetCache()
  mockOR = null
  mockMD = null
  {
    const orig = { id: 'x/y', name: '原名', context_length: 100 }
    const r = await enrichModel('x/y', orig)
    check('场景6 失败返回原metadata', r, { id: 'x/y', name: '原名', context_length: 100 })
    checkTrue('场景6 原对象不被修改', orig.context_length === 100 && r !== orig)
  }

  // ── 场景 7：OR 失败 → MD 兜底全量补（OR fetch 500，MD 正常）──
  _resetCache()
  mockOR = null
  mockMD = MD_CATALOG
  {
    const r = await enrichModel('custom-glm/glm-5.2', { id: 'custom-glm/glm-5.2' })
    // OR 失败，name 由 MD 补
    check('场景7 name=MD补', r.name, 'GLM 5.2')
    check('场景7 context_length=MD', r.context_length, 1000000)
    check('场景7 max_output_length=MD', r.max_output_length, 131072)
    check('场景7 sampling=MD', r.supported_sampling_parameters, ['tools', 'response_format', 'json_schema', 'temperature', 'top_p'])
  }

  // ── 场景 8：MD 失败 → OR 兜底（MD fetch 500，OR 正常）──
  _resetCache()
  mockOR = OR_DATA
  mockMD = null
  {
    const r = await enrichModel('custom-glm/glm-5.2', { id: 'custom-glm/glm-5.2' })
    // OR 匹配，name=OR；MD 失败，max_output_length OR 也缺（无 top_provider）→ 不补
    check('场景8 name=OR', r.name, 'Z.ai: GLM 5.2')
    check('场景8 context_length=OR', r.context_length, 128000)
    checkTrue('场景8 max_output_length未补（OR缺、MD失败）', r.max_output_length === undefined)
  }

  // ── 场景 9：模块级缓存（二次调用不重复 fetch）──
  _resetCache()
  mockOR = OR_DATA
  mockMD = MD_CATALOG
  orCallCount = mdCallCount = 0
  {
    await enrichModel('custom-glm/glm-5.2', { id: 'custom-glm/glm-5.2' })
    const or1 = orCallCount
    const md1 = mdCallCount
    checkTrue('场景9 首次调用 fetch 各 1 次', or1 === 1 && md1 === 1)
    await enrichModel('custom-openai/gpt-4o', { id: 'custom-openai/gpt-4o' })
    checkTrue('场景9 二次调用走缓存不 fetch', orCallCount === 1 && mdCallCount === 1)
  }

  // ── 场景 10：MD modalities 覆盖 OR 缺失（OR 无 output_modalities，MD 补）──
  _resetCache()
  mockOR = [
    {
      id: 'z-ai/glm-5.2',
      name: 'Z.ai: GLM 5.2',
      context_length: 128000,
      // architecture 故意不提供 output_modalities，也不提供 modality
      architecture: { input_modalities: ['text'] },
      supported_parameters: ['tools'],
    },
  ]
  mockMD = MD_CATALOG
  {
    const r = await enrichModel('custom-glm/glm-5.2', { id: 'custom-glm/glm-5.2' })
    // OR 补 input_modalities=['text']，output_modalities 缺
    check('场景10 input_modalities=OR', r.input_modalities, ['text'])
    // MD 补 output_modalities=['text']
    check('场景10 output_modalities=MD补', r.output_modalities, ['text'])
  }
} finally {
  globalThis.fetch = originalFetch
}

console.log(`\n${failed ? '❌ 有失败' : '✅ 全部通过'}`)
process.exit(failed ? 1 : 0)
