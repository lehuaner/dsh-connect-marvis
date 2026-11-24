// 验证：什么情况下 fetch 会发出空/截断 body（对应 4100400 非法请求）
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
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(36)} HTTP ${res.status} code=${code.padEnd(8)} ${text.slice(0, 70).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(36)} EXC ${e.message}`)
  }
}

console.log('=== body 类型 / 编码问题 ===')
await raw('body 是 Buffer', { method: 'POST', headers, body: Buffer.from(BODY) })
await raw('body 是 Uint8Array', { method: 'POST', headers, body: new TextEncoder().encode(BODY) })
await raw('body 含 BOM', { method: 'POST', headers, body: '\uFEFF' + BODY })
await raw('body 含 NUL', { method: 'POST', headers, body: BODY + '\u0000' })

console.log('\n=== 已 abort 的 signal ===')
const ac1 = new AbortController(); ac1.abort()
await raw('signal 预先 abort', { method: 'POST', headers, body: BODY, signal: ac1.signal })

console.log('\n=== 双重发送（body 被消费两次）===')
const { Readable } = await import('node:stream')
try {
  const s = Readable.from([BODY])
  const res = await fetch(CHAT_URL, { method: 'POST', headers, body: s, duplex: 'half', signal: AbortSignal.timeout(30000) })
  const t = await res.text()
  console.log(`${res.status === 200 ? '✓' : '✗'} ${'stream body'.padEnd(36)} HTTP ${res.status} ${t.slice(0, 70).replace(/\n/g, ' ')}`)
} catch (e) { console.log(`✗ stream body EXC ${e.message}`) }

console.log('\n=== Content-Length 与实际不符 ===')
await raw('CL 写大 100', { method: 'POST', headers: { ...headers, 'Content-Length': String(BODY.length + 100) }, body: BODY })
await raw('CL 写小 10', { method: 'POST', headers: { ...headers, 'Content-Length': String(BODY.length - 10) }, body: BODY })
