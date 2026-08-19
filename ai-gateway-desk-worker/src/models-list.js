// ============================================================
// 精选模型列表（默认值）
// ============================================================
// 当 KV 中未设置模型列表时，使用此默认列表。
// 部署后如果想更新模型，无需重新部署 Worker：
//   方式一：wrangler kv:key put --binding=MODELS_KV "models" "$(cat path/to/list.json)"
//   方式二：Cloudflare Dashboard → Workers & Pages → KV → 编辑 models key
//
// 每项格式参考：
//   id                          - 客户端使用的模型 ID（如 openai/gpt-4o-mini）
//   object                      - 固定 "model"
//   name                        - 人类可读名称
//   created                     - 时间戳（整数，秒）
//   owned_by                    - 厂商标识
//   context_length              - 上下文窗口大小
//   max_output_length           - 最大输出长度
//   input_modalities            - 支持的输入模态（text / image / audio 等）
//   output_modalities           - 支持的输出模态（text / image / audio 等）
//   supported_sampling_parameters - 支持的采样参数列表
//   supported_features          - 支持的高级功能（tools / json_mode / reasoning 等）
//   description                 - 模型能力描述（供客户端展示）
//
// 此格式兼容 OpenAI / OpenRouter / 商汤等多种 agent 识别的模型列表风格。
// ============================================================

// 初始为空数组，因为 AI Gateway 使用 BYOK 模式，
// 添加 Provider 后才会有可用模型。
// 部署后通过 KV 写入模型列表：wrangler kv:key put --binding=MODELS_KV "models" "$(cat models.json)"
//
// 写入 KV 的 JSON 格式示例（每项一个模型）：
// [
//   {
//     "id": "openai/gpt-4o-mini",
//     "object": "model",
//     "name": "GPT-4o Mini",
//     "created": 1720000000,
//     "owned_by": "openai",
//     "context_length": 128000,
//     "max_output_length": 16384,
//     "input_modalities": ["text", "image"],
//     "output_modalities": ["text"],
//     "supported_sampling_parameters": ["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty"],
//     "supported_features": ["tools", "json_mode", "structured_outputs"],
//     "description": "GPT-4o Mini is a fast and affordable small model for everyday tasks."
//   },
//   {
//     "id": "deepseek/deepseek-chat",
//     "object": "model",
//     "name": "DeepSeek V3",
//     "created": 1720000000,
//     "owned_by": "deepseek",
//     "context_length": 163840,
//     "max_output_length": 16000,
//     "input_modalities": ["text"],
//     "output_modalities": ["text"],
//     "supported_sampling_parameters": ["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty"],
//     "supported_features": ["tools", "json_mode"],
//     "description": "DeepSeek V3 is a 671B MoE model with strong reasoning and coding capabilities."
//   }
// ]
const defaultModels = []

export default defaultModels
