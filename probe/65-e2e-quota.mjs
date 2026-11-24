// 端到端：模拟真实 agent 多轮工具循环，观察配额退避是否生效
import { MarvisAdapter } from '../src/adapter.js'

const logs = []
const adapter = new MarvisAdapter({
  debug: () => {},
  warn: m => { logs.push(m); console.log(`  [warn] ${m}`) },
})

const tools = [{
  name: 'read',
  description: '读文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}]

let messages = [{ role: 'user', content: [{ type: 'text', text: '用工具读一下 a.txt，然后告诉我内容。' }] }]

console.log('=== 模拟 8 轮工具循环（真实 agent 形状）===')
for (let round = 1; round <= 8; round++) {
  const t0 = Date.now()
  let finish = null, text = '', calls = []
  try {
    for await (const c of adapter.stream({
      provider: 'marvis', model: 'main-auto', messages, tools, maxTokens: 256,
    })) {
      if (c.type === 'text-delta') text += c.text
      if (c.type === 'block-end' && c.block?.type === 'tool-call') calls.push(c.block)
      if (c.type === 'finish') finish = c.reason
    }
  } catch (e) {
    console.log(`第 ${round} 轮 EXC ${e.message}`)
    break
  }
  const ms = Date.now() - t0
  if (finish?.kind === 'error') {
    console.log(`✗ 第 ${round} 轮 ${ms}ms 失败: [${finish.failure?.code}] ${finish.failure?.message?.slice(0, 70)}`)
    break
  }
  console.log(`✓ 第 ${round} 轮 ${ms}ms [${finish?.kind}] text=${text.length} calls=${calls.length}`)

  // 有工具调用就回填结果，继续下一轮
  if (calls.length > 0) {
    messages = [
      ...messages,
      { role: 'assistant', content: calls.map(c => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })) },
      ...calls.map(c => ({
        role: 'tool',
        toolCallId: c.id,
        content: [{ type: 'text', text: '文件内容是 hello' }],
      })),
    ]
  } else {
    console.log('  无工具调用，循环结束')
    break
  }
}

console.log(`\n=== 退避日志 (${logs.length} 条) ===`)
for (const l of logs) console.log(`  ${l}`)
