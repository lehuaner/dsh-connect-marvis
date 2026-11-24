// 复现 403：真实的多轮对话形态（tool-call / tool-result 交替、reasoning_content、空 content）
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

async function tryIt(tag, opts) {
  let text = ''
  let finish = null
  const t0 = Date.now()
  try {
    for await (const chunk of adapter.stream({ provider: 'marvis', model: 'main-auto', ...opts })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const ok = finish?.kind === 'stop' || finish?.kind === 'tool-calls'
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(40)} ${Date.now() - t0}ms  ${ok ? (text.trim().slice(0, 16) || finish.kind) : JSON.stringify(finish)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
  }
}

const tools = [{
  name: 'read_file',
  description: '读取文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

console.log('=== 多轮工具循环 ===')

// 1) assistant 带 reasoning_content
await tryIt('assistant 带 reasoning_content', {
  maxTokens: 200,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '读一下 a.txt' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }], reasoning_content: '用户要我读文件' },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ],
})

// 2) assistant 纯 tool-call（content 为空）
await tryIt('assistant 纯 tool-call', {
  maxTokens: 200, tools,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
  ],
})

// 3) 并行工具调用
await tryIt('并行两个 tool-call', {
  maxTokens: 200, tools,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '读 a.txt 和 b.txt' }] },
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'tool-call', id: 'call_2', name: 'read_file', arguments: '{"path":"b.txt"}' },
    ] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'AAA' }] },
    { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'BBB' }] },
  ],
})

// 4) 工具结果里带图
await tryIt('tool 结果带图', {
  maxTokens: 200, tools,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '截图看看' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [
      { type: 'text', text: '这是截图' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ] },
  ],
})

// 5) user 消息带图
await tryIt('user 消息带图', {
  maxTokens: 200,
  messages: [{ role: 'user', content: [
    { type: 'text', text: '这是什么' },
    { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  ] }],
})

// 6) 连续同角色消息（真实会话里很常见）
await tryIt('连续两条 user', {
  maxTokens: 200,
  messages: [
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    { role: 'user', content: [{ type: 'text', text: '第二句' }] },
  ],
})
