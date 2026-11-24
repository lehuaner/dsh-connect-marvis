// 复现 403：abort / 取消后重发的请求
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })
const messages = [{ role: 'user', content: [{ type: 'text', text: '写一段 200 字的说明' }] }]

async function once(tag, { abortAfterMs } = {}) {
  const ac = new AbortController()
  let finish = null, text = ''
  const t0 = Date.now()
  if (abortAfterMs !== undefined) setTimeout(() => ac.abort(), abortAfterMs)
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis', model: 'main-auto', messages, maxTokens: 512, signal: ac.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    console.log(`${finish?.kind === 'error' ? '✗' : '✓'} ${tag.padEnd(38)} ${Date.now() - t0}ms [${finish?.kind}] ${finish?.kind === 'error' ? JSON.stringify(finish.failure) : `len=${text.length}`}`)
    return finish
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
    return null
  }
}

console.log('=== abort 行为 ===')
await once('正常完成', {})
await once('50ms 后 abort', { abortAfterMs: 50 })
await once('200ms 后 abort', { abortAfterMs: 200 })
await once('abort 后立刻再发', { abortAfterMs: 50 })
await once('紧接再发（验状态未污染）', {})

console.log('\n=== 同一 adapter 并发 3 路 ===')
const results = await Promise.all([
  once('并发 A', {}),
  once('并发 B', {}),
  once('并发 C', {}),
])
console.log('全部结束:', results.map(r => r?.kind).join(', '))
