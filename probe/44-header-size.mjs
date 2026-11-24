// 复现 403：header 总长 / MarvisExt 长度超限
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

async function send(tag, mutate) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  if (mutate) mutate(headers)
  const total = Object.entries(headers).reduce((n, [k, v]) => n + k.length + String(v).length + 4, 0)
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(36)} HTTP ${res.status} 总长=${total}  ${ok ? '' : text.slice(0, 110)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(36)} EXC ${e.message}`)
  }
}

console.log('=== 填充无关 header 撑大总长 ===')
for (const n of [0, 2000, 4000, 8000, 12000, 16000, 20000]) {
  await send(`+填充 ${n}B`, h => { if (n > 0) h['X-Filler'] = 'a'.repeat(n) })
}

console.log('\n=== 截断 MarvisExt ===')
for (const cut of [0, 100, 300, 600, 780]) {
  await send(`MarvisExt 截掉 ${cut}`, h => {
    if (cut > 0) { const e = h['Ual-Access-MarvisExt']; h['Ual-Access-MarvisExt'] = e.slice(0, e.length - cut) }
  })
}
