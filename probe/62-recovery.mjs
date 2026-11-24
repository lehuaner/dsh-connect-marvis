// 精确测量：限流触发后多久恢复
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })
const mk = i => JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 8,
  messages: [{ role: 'user', content: `ping${i}` }],
})

let n = 0
async function hit() {
  n++
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: mk(n), signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    return { ok: res.status === 200, code, ms: Date.now() - t0, status: res.status }
  } catch (e) { return { ok: false, code: 'EXC', ms: Date.now() - t0, status: 0 } }
}

// 先打到限流
console.log('=== 先打到限流 ===')
let tripped = false
for (let i = 0; i < 12; i++) {
  const r = await hit()
  console.log(`  #${n} ${r.ok ? '✓' : '✗'} ${r.ms}ms ${r.code}`)
  if (!r.ok) { tripped = true; break }
  await new Promise(r => setTimeout(r, 1200))
}
if (!tripped) { console.log('  未触发限流，跳过'); process.exit(0) }

console.log('\n=== 每 30s 探一次，记录恢复时间 ===')
const start = Date.now()
for (let i = 1; i <= 20; i++) {
  await new Promise(r => setTimeout(r, 30000))
  const r = await hit()
  const el = Math.round((Date.now() - start) / 1000)
  console.log(`  ${el}s  ${r.ok ? '✓ 恢复' : '✗ 仍限流'}  ${r.ms}ms ${r.code}`)
  if (r.ok) { console.log(`\n>>> 恢复用时约 ${el} 秒`); break }
}
