// 复现 403：并发请求 + 快速连续请求（DSH 会同时跑压缩/标题/主对话）
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

async function one(tag) {
  let finish = null
  let text = ''
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis', model: 'main-auto', maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: `只回答两个字：收到(${tag})` }] }],
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    return { tag, ok: finish?.kind === 'stop', text: text.trim().slice(0, 12), finish }
  } catch (e) {
    return { tag, ok: false, err: e.message }
  }
}

console.log('=== 并发 3 个 ===')
const r3 = await Promise.all([one('a'), one('b'), one('c')])
for (const r of r3) console.log(`  ${r.ok ? '✓' : '✗'} ${r.tag} ${r.ok ? r.text : JSON.stringify(r.finish ?? r.err)}`)

console.log('\n=== 并发 6 个 ===')
const r6 = await Promise.all([1,2,3,4,5,6].map(i => one(`n${i}`)))
for (const r of r6) console.log(`  ${r.ok ? '✓' : '✗'} ${r.tag} ${r.ok ? r.text : JSON.stringify(r.finish ?? r.err)}`)

console.log('\n=== 串行快速 10 连 ===')
for (let i = 0; i < 10; i++) {
  const r = await one(`s${i}`)
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.tag} ${r.ok ? r.text : JSON.stringify(r.finish ?? r.err)}`)
}
