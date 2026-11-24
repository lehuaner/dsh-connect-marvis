// 复现 403：大请求体 / 超长历史 / 大量工具结果
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

async function tryIt(tag, opts) {
  let finish = null
  let text = ''
  const t0 = Date.now()
  try {
    for await (const chunk of adapter.stream({ provider: 'marvis', model: 'main-auto', ...opts })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const ok = finish?.kind === 'stop' || finish?.kind === 'tool-calls'
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(38)} ${Date.now() - t0}ms  ${ok ? (text.trim().slice(0, 14) || finish.kind) : JSON.stringify(finish)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
  }
}

const tools = [{
  name: 'read_file', description: '读取文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

// 构造带大量工具结果的真实历史
function bigHistory(rounds, resultSize) {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '开始干活' }] }]
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool-call', id: `call_${i}`, name: 'read_file', arguments: `{"path":"f${i}.txt"}` }] })
    msgs.push({ role: 'tool', toolCallId: `call_${i}`, content: [{ type: 'text', text: `文件${i}内容：` + 'x'.repeat(resultSize) }] })
  }
  msgs.push({ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] })
  return msgs
}

console.log('=== 请求体规模梯度 ===')
for (const [rounds, size] of [[10, 1000], [30, 2000], [60, 4000], [100, 8000]]) {
  const msgs = bigHistory(rounds, size)
  const approx = JSON.stringify(msgs).length
  await tryIt(`${rounds}轮×${size}B (~${Math.round(approx / 1024)}KB)`, { messages: msgs, tools, maxTokens: 200 })
}

console.log('\n=== 单条超长文本 ===')
for (const n of [50_000, 200_000, 500_000]) {
  await tryIt(`单条 ${n} 字符`, {
    maxTokens: 200,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(n) + '\n只回答两个字：收到' }] }],
  })
}
