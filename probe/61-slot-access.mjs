// 严格验证 slot 限制：每个 slot 之间留足间隔，且每次先确认限流未触发
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'
import { MODELS } from '../src/models.js'

const account = await getAccount()
const body = (slot, i) => JSON.stringify({
  model: slot, stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: `测试${i}，只回答两个字：收到` }],
})

async function hit(slot, i) {
  const h = await marvisHeaders(account, { slot })
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers: h, body: body(slot, i), signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = '', served = ''
    try { const j = JSON.parse(text); code = String(j?.code ?? ''); served = String(j?.model ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${slot.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms HTTP ${res.status} ${code ? 'code=' + code : 'served=' + served}`)
    return res.status === 200
  } catch (e) {
    console.log(`✗ ${slot.padEnd(28)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 逐个 slot，间隔 20s，共 7 个 ===')
const results = []
for (const m of MODELS) {
  const ok = await hit(m.id, results.length + 1)
  results.push([m.id, ok])
  await new Promise(r => setTimeout(r, 20000))
}

console.log('\n=== 汇总 ===')
for (const [slot, ok] of results) console.log(`  ${ok ? '✓ 可用' : '✗ 拒绝'}  ${slot}`)
