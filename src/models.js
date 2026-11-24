/**
 * Marvis 模型槽位表。
 *
 * ⚠ `model` 字段必须传**槽位名**（本表的 id 列），不能传上游真实模型 id。
 *   传真实 id 会 400 4130001「无效模型id」。
 *
 * ⚠ 本机实测：所有槽位都路由到 `deepseek-v4-flash-ga-260731`。
 *   这是账号侧的降级路由（服务端按账号改路由），不是本插件的问题 ——
 *   换账号或账号恢复后，`model` 字段会自动跟着变回真实模型。
 *   所以 `name` 写槽位的人话描述，`servedAs` 留作诊断。
 */

/**
 * @typedef {object} MarvisModel
 * @property {string} id 槽位名，传给上游的 `model` 字段
 * @property {string} name 展示名
 * @property {string} description 一句话说明
 * @property {number} contextWindow
 * @property {number} maxOutput
 * @property {boolean} vision
 * @property {boolean} reasoning
 * @property {string[]} [efforts]
 */

/** @type {readonly MarvisModel[]} */
export const MODELS = Object.freeze([
  {
    id: 'main-auto',
    name: 'DeepSeek V4.1 Flash',
    description: 'Marvis 默认对话槽位，综合能力最均衡，支持推理、工具与图像输入',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    vision: true,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
  },
  {
    id: 'deepseek-v4-pro-external',
    name: 'DeepSeek V4 Pro',
    description: 'Pro 档槽位；账号被降级路由时可能落到 Flash，实际模型见响应',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    vision: true,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic Sonnet 4.6 槽位（是否可用取决于账号权益）',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    vision: true,
    reasoning: true,
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Anthropic Opus 4.6 槽位（是否可用取决于账号权益）',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    vision: true,
    reasoning: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'OpenAI GPT-5.4 槽位（是否可用取决于账号权益）',
    contextWindow: 1_000_000,
    maxOutput: 65_536,
    vision: true,
    reasoning: true,
  },
  {
    id: 'hy3-preview-agent-real',
    name: '混元 Hy3',
    description: '腾讯混元 Hy3 槽位',
    contextWindow: 1_000_000,
    maxOutput: 32_768,
    vision: false,
    reasoning: true,
  },
  {
    id: 'hunyuan-turbos-vision',
    name: 'HY-Vision 2.0',
    description: '腾讯混元视觉模型，适合看图',
    contextWindow: 32_000,
    maxOutput: 8_192,
    vision: true,
    reasoning: false,
  },
])

/** 默认模型 */
export const DEFAULT_MODEL = 'main-auto'

/**
 * 按 id 找模型。
 * @param {string} id
 * @returns {MarvisModel | undefined}
 */
export function findModel(id) {
  return MODELS.find(model => model.id === id)
}

/** 模型目录给 DSH 的形态 */
export function catalog() {
  return MODELS.map(model => ({
    provider: 'marvis',
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: model.vision ? ['text', 'image'] : ['text'],
  }))
}
