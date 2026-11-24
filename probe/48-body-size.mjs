// 复现 403「非法请求」：请求体体积超限（压缩会打包整段对话）
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()

async function sendBytes(tag, bytes) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  // 用一段合法 JSON，把填充放在 content 里，保证是真实可解析的请求
  const filler = 'x'.repeat(Math.max(0, bytes - 400))
  const body = JSON.stringify({
    model: 'main-auto', stream: false, max_tokens: 16,
    messages: [{ role: 'user', content: filler }],
  })
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(180000) })
    const text = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(26)} 实际=${(body.length/1048576).toFixed(2)}MB HTTP ${res.status}  ${ok ? '' : text.slice(0, 150).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(26)} 实际=${(body.length/1048576).toFixed(2)}MB EXC ${e.message}`)
  }
}

console.log('=== 请求体体积梯度 ===')
for (const mb of [1, 2, 3, 4, 5, 6, 8]) {
  await sendBytes(`目标 ${mb}MB`, mb * 1048576)
}
