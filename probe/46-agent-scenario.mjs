// 复现 403：完整 agent 场景（工具循环 + reasoningEffort + 多轮累积）
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

const tools = [
  { name: 'read', description: '读文件，返回带行号的文本。', parameters: { type: 'object', properties: { filePath: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['filePath'] } },
  { name: 'write', description: '写文件。', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } },
  { name: 'edit', description: '局部替换。', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' } }, required: ['filePath', 'oldString', 'newString'] } },
  { name: 'bash', description: '执行命令。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] } },
  { name: 'grep', description: '正则搜索。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } },
]

const system = `你是编码代理。工作目录 D:\\Code\\Project\\未知\\dsh。先读后改，用中文回答。`

async function run(tag, opts) {
  let finish = null, text = '', toolCalls = 0
  const t0 = Date.now()
  try {
    for await (const chunk of adapter.stream({ provider: 'marvis', model: 'main-auto', ...opts })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'tool-call-delta') toolCalls++
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const ok = finish !== null && finish.kind !== 'error'
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(40)} ${Date.now() - t0}ms [${finish?.kind}] ${ok ? (text.trim().slice(0, 24) || `${toolCalls} deltas`) : JSON.stringify(finish)}`)
    return ok
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 完整 agent 场景 ===')
await run('带 system+tools+effort=high', {
  system, tools, maxTokens: 1024, reasoningEffort: 'high',
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
})

await run('带 system+tools 无 effort', {
  system, tools, maxTokens: 1024,
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
})

// 模拟多轮工具循环累积（这是压缩前真实的历史形状）
console.log('\n=== 多轮工具循环累积 ===')
const history = [{ role: 'user', content: [{ type: 'text', text: '帮我看下 adapter.js 的结构' }] }]
for (let i = 0; i < 6; i++) {
  history.push({ role: 'assistant', content: [
    { type: 'tool-call', id: `call_${i}`, name: 'read', arguments: JSON.stringify({ filePath: 'src/adapter.js', offset: i * 50, limit: 50 }) },
  ], reasoning_content: `第 ${i} 轮，我要读取 adapter.js 的第 ${i * 50} 行开始的 50 行，以了解它的结构。` })
  history.push({ role: 'tool', toolCallId: `call_${i}`, content: [{ type: 'text', text: Array.from({ length: 50 }, (_, j) => `${i * 50 + j + 1}: export function marvisHeaders(account, { slot }) { /* 第 ${i * 50 + j} 行 */ }`).join('\n') }] })
  const ok = await run(`第 ${i + 1} 轮 (${history.length} 条消息)`, { system, tools, maxTokens: 256, messages: [...history] })
  if (!ok) { console.log('  ↑ 失败，停止'); break }
  history.push({ role: 'assistant', content: [{ type: 'text', text: `已读第 ${i + 1} 段。` }] })
}
