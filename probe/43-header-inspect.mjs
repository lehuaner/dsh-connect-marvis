// 复现 403：header 值含非 ASCII / 超长 / 特殊字符时被静默丢弃
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()

async function probe(tag, mutate) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  if (mutate) mutate(headers)
  // 先用 httpbin 类服务看真实发出的头 —— 这里直接看 fetch 是否接受
  const entries = Object.entries(headers)
  let nonAscii = []
  for (const [k, v] of entries) {
    for (const ch of String(v)) if (ch.charCodeAt(0) > 126) { nonAscii.push(k); break }
  }
  let res, text
  try {
    res = await fetch(CHAT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16, messages: [{ role: 'user', content: '只回答两个字：收到' }] }),
      signal: AbortSignal.timeout(60000),
    })
    text = await res.text()
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
    return
  }
  const ok = res.status === 200
  console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(38)} HTTP ${res.status}  非ASCII头=${nonAscii.join(',') || '无'}  ${ok ? '' : text.slice(0, 110)}`)
}

console.log('=== 当前请求头实况 ===')
const h = await marvisHeaders(account, { slot: 'main-auto' })
for (const [k, v] of Object.entries(h)) {
  const s = String(v)
  const hasNonAscii = [...s].some(c => c.charCodeAt(0) > 126)
  console.log(`  ${k.padEnd(28)} len=${String(s.length).padStart(4)} ${hasNonAscii ? '⚠非ASCII' : ''}  ${s.slice(0, 60)}${s.length > 60 ? '…' : ''}`)
}

console.log('\n=== 发请求 ===')
await probe('基线', null)
