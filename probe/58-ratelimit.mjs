// 关键验证：4100404 是不是限流（连续请求触发，等一会儿就恢复）
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })
const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

async function one(tag) {
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(28)} HTTP ${res.status} code=${code.padEnd(8)} ${Date.now() - t0}ms`)
    return res.status === 200
  } catch (e) {
    console.log(`✗ ${tag.padEnd(28)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 冷却中，立刻重试 ===')
await one('立刻 #1')
await one('立刻 #2')

console.log('\n=== 等待后重试（每 5 秒）===')
for (let i = 1; i <= 8; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const ok = await one(`${i * 5}s 后`)
  if (ok) { console.log(`  → 恢复了，冷却约 ${i * 5}s`); break }
}
