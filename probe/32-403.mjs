// 复现 403 非法请求：逐项试 max_tokens / 长上下文 / 参数组合
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

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
    console.log(`${okFlag ? '✓' : '✗'} ${tag.padEnd(28)} ${Date.now() - t0}ms  ${okFlag ? text.trim().slice(0, 20) : JSON.stringify(finish)}`)
    return okFlag
  } catch (e) {
    console.log(`✗ ${tag.padEnd(28)} EXC ${e.message}`)
    return false
  }
}

console.log('=== max_tokens 梯度 ===')
for (const n of [32, 1024, 4096, 8192, 16384, 32768, 65536]) {
  await tryIt(`maxTokens=${n}`, { maxTokens: n })
}

console.log('\n=== 带 temperature ===')
await tryIt('maxTokens=32768 + temp0.2', { maxTokens: 32768, temperature: 0.2 })
await tryIt('maxTokens=1024 + temp0.2', { maxTokens: 1024, temperature: 0.2 })

console.log('\n=== 长上下文 ===')
const longText = '这是一段用来撑大上下文的测试文本。'.repeat(2000) // ~3.4 万字符
await tryIt('long(~34k chars) maxTokens=1024', {
  maxTokens: 1024,
  messages: [{ role: 'user', content: [{ type: 'text', text: longText + '\n只回答两个字：收到' }] }],
})
