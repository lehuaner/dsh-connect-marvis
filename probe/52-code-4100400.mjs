// 确认 4100400 的所有触发条件，并验证 403 vs 400 的映射
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

async function raw(tag, init) {
  try {
    const res = await fetch(CHAT_URL, { ...init, signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(30)} HTTP ${res.status} code=${code.padEnd(8)} ${text.slice(0, 80).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(30)} EXC ${e.message}`)
  }
}

const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

console.log('=== 4100400「非法请求」触发面 ===')
await raw('正常', { method: 'POST', headers, body: BODY })
await raw('缺 messages', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16 }) })
await raw('缺 model', { method: 'POST', headers, body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: 'hi' }] }) })
await raw('messages 空数组', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', messages: [] }) })
await raw('messages 非数组', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', messages: 'x' }) })
await raw('max_tokens 负数', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', max_tokens: -1, messages: [{ role: 'user', content: 'hi' }] }) })
await raw('max_tokens 字符串', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', max_tokens: 'abc', messages: [{ role: 'user', content: 'hi' }] }) })
await raw('temperature 越界', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', temperature: 99, messages: [{ role: 'user', content: 'hi' }] }) })
await raw('role 非法', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', messages: [{ role: 'wizard', content: 'hi' }] }) })
await raw('content 是数字', { method: 'POST', headers, body: JSON.stringify({ model: 'main-auto', messages: [{ role: 'user', content: 123 }] }) })
