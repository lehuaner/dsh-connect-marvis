// 定位「非法请求」的确切来源：哪种 HTTP 畸形会返回纯文本 403
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })
const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

async function raw(tag, init) {
  try {
    const res = await fetch(CHAT_URL, { ...init, signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    const ct = res.headers.get('content-type') ?? ''
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(34)} ${res.status} ct=${ct.split(';')[0].padEnd(18)} ${text.slice(0, 100).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(34)} EXC ${e.message}`)
  }
}

console.log('=== HTTP 层面畸形 ===')
await raw('基线 POST', { method: 'POST', headers, body: BODY })
await raw('GET', { method: 'GET', headers })
await raw('PUT', { method: 'PUT', headers, body: BODY })
await raw('空 body', { method: 'POST', headers, body: '' })
await raw('无 body', { method: 'POST', headers })
await raw('body = null 字面量', { method: 'POST', headers, body: 'null' })
await raw('body = {}', { method: 'POST', headers, body: '{}' })
await raw('body 非 JSON', { method: 'POST', headers, body: 'hello' })
await raw('body 截断 JSON', { method: 'POST', headers, body: BODY.slice(0, 40) })

console.log('\n=== 路径 / 域名变体 ===')
for (const u of [
  'https://yybadaccess.3g.qq.com/v1/chat/completions/',
  'https://yybadaccess.3g.qq.com/v1/chat/completions?x=1',
  'https://yybadaccess.3g.qq.com//v1/chat/completions',
]) {
  try {
    const res = await fetch(u, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(30000) })
    const t = await res.text()
    console.log(`${res.status === 200 ? '✓' : '✗'} ${u.slice(24, 70).padEnd(48)} ${res.status} ${t.slice(0, 90).replace(/\n/g, ' ')}`)
  } catch (e) { console.log(`✗ ${u.slice(24, 70)} EXC ${e.message}`) }
}
