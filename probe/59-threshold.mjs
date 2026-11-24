// 精确找出 4100404 的触发阈值：是计数还是时间窗
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })
const mk = i => JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: `第${i}次，只回答两个字：收到` }],
})

async function one(i) {
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: mk(i), signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} #${String(i).padStart(2)}  ${String(Date.now() - t0).padStart(5)}ms  HTTP ${res.status} ${code}`)
    return ok
  } catch (e) {
    console.log(`✗ #${String(i).padStart(2)}  EXC ${e.message}`)
    return false
  }
}

console.log('=== 连续 25 次，间隔 1.5s，找断点 ===')
let firstFail = 0
for (let i = 1; i <= 25; i++) {
  const ok = await one(i)
  if (!ok && firstFail === 0) { firstFail = i; console.log(`  ▲ 首次失败在第 ${i} 次`) }
  await new Promise(r => setTimeout(r, 1500))
}
console.log(`\n结果：首次失败 = ${firstFail || '未失败'}`)

console.log('\n=== 失败后再等 60s，看是否恢复 ===')
await new Promise(r => setTimeout(r, 60000))
await one(99)
