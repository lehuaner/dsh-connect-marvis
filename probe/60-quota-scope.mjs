// 确认配额是否按天/按小时重置，以及是否与 4 次成功有关
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })
const mk = i => JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: `测试${i}，只回答两个字：收到` }],
})

async function one(i, slot = 'main-auto') {
  const h = await marvisHeaders(account, { slot })
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers: h, body: mk(i), signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${slot.padEnd(26)} #${String(i).padStart(2)} ${String(Date.now() - t0).padStart(5)}ms HTTP ${res.status} ${code}`)
    return res.status === 200
  } catch (e) {
    console.log(`✗ ${slot.padEnd(26)} #${String(i).padStart(2)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 当前状态：直接试一次 ===')
await one(0)

console.log('\n=== 换 slot 是否绕开配额 ===')
for (const s of ['deepseek-v4-pro-external', 'claude-sonnet-4-6', 'gpt-5.4', 'hunyuan-turbos-vision']) {
  await one(0, s)
}

console.log('\n=== 等 3 分钟后重试 main-auto ===')
await new Promise(r => setTimeout(r, 180000))
await one(0)
