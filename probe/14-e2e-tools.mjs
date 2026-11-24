// 端到端：用完全真实的 adapter + 真实账号，跑一轮带工具的完整对话
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

const messages = [
  { role: 'user', content: [{ type: 'text', text: '帮我算一下 17 * 23 等于多少，必须调用 calculate 工具。' }] },
]

const tools = [{
  name: 'calculate',
  description: '计算一个数学表达式',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: '要计算的表达式' } },
    required: ['expression'],
  },
}]

console.log('=== 第一轮：期望产生工具调用 ===')
const calls = []
for await (const chunk of adapter.stream({
  provider: 'marvis', model: 'main-auto', messages, tools, maxTokens: 300,
})) {
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push(chunk.block)
  if (chunk.type === 'finish') console.log('  finish:', JSON.stringify(chunk.reason))
}
console.log('  工具调用:', JSON.stringify(calls, null, 2))

if (calls.length === 0) {
  console.log('  没产生工具调用，跳过第二轮')
  process.exit(0)
}

// 第二轮：把工具结果回灌
const call = calls[0]
messages.push({
  role: 'assistant',
  content: [{ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }],
})
messages.push({
  role: 'tool',
  toolCallId: call.id,
  content: [{ type: 'text', text: '391' }],
})

console.log('\n=== 第二轮：期望基于工具结果作答 ===')
let text = ''
for await (const chunk of adapter.stream({
  provider: 'marvis', model: 'main-auto', messages, tools, maxTokens: 300,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') console.log('  finish:', JSON.stringify(chunk.reason))
}
console.log('  回答:', text)
