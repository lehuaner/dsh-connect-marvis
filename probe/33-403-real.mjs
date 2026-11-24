// 复现 403：模拟 DSH 真实请求（长 system + 大量 tools + reasoningEffort 等）
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

const longSystem = `你是 DeepSeek Harness 的编码代理。你现在在 Windows 上工作，工作目录是 D:\\Code\\Project\\未知\\dsh。
你可以使用工具来读取文件、搜索代码、执行命令。规则：
1. 始终先读文件再修改。
2. 用中文回答。
${'这是一段补充规则，用来模拟真实的长系统提示。'.repeat(300)}`

const tools = Array.from({ length: 30 }, (_, i) => ({
  name: `tool_${i}`,
  description: `这是第 ${i} 个工具的说明，用于测试大量工具声明时的行为。` + '细节说明。'.repeat(20),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '内容' },
      recursive: { type: 'boolean' },
    },
    required: ['path'],
  },
}))

async function tryIt(tag, opts) {
  let text = ''
  let finish = null
  const t0 = Date.now()
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis',
      model: 'main-auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
      ...opts,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const okFlag = finish?.kind === 'stop'
    console.log(`${okFlag ? '✓' : '✗'} ${tag.padEnd(34)} ${Date.now() - t0}ms  ${okFlag ? text.trim().slice(0, 20) : JSON.stringify(finish)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(34)} EXC ${e.message}`)
  }
}

console.log('system 长度:', longSystem.length, '  工具数:', tools.length)

console.log('\n=== 逐项加复杂度 ===')
await tryIt('仅长 system', { system: longSystem, maxTokens: 1024 })
await tryIt('仅 tools(30)', { tools, maxTokens: 1024 })
await tryIt('长 system + tools(30)', { system: longSystem, tools, maxTokens: 1024 })
await tryIt('+ reasoningEffort=high', { system: longSystem, tools, maxTokens: 1024, reasoningEffort: 'high' })
await tryIt('+ stop 序列', { system: longSystem, tools, maxTokens: 1024, stop: ['\n\n\n'] })
await tryIt('+ sessionId/purpose', {
  system: longSystem, tools, maxTokens: 1024,
  sessionId: 'session-abc', purpose: 'chat',
})
await tryIt('全套 + maxTokens=32768', {
  system: longSystem, tools, maxTokens: 32768, temperature: 0.7,
})
