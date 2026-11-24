// 定位：消息序列以 assistant 结尾 / 首尾角色形状导致的 4100404
import { toChatMessages } from '../src/messages.js'
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

async function send(tag, msgs) {
  const body = JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16, messages: msgs })
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(42)} HTTP ${res.status} code=${code.padEnd(8)} ${text.slice(0, 50).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(42)} EXC ${e.message}`)
  }
}

const U = t => ({ role: 'user', content: t })
const A = t => ({ role: 'assistant', content: t })

console.log('=== 序列形状 ===')
await send('user 结尾', [U('hi'), A('你好'), U('只回答两个字：收到')])
await send('assistant 结尾', [U('hi'), A('你好')])
await send('assistant 结尾(null)', [U('hi'), A(null)])
await send('assistant 结尾(空串)', [U('hi'), A('')])
await send('只有 assistant', [A('你好')])
await send('只有 system', [{ role: 'system', content: '你是助手' }])
await send('system+assistant', [{ role: 'system', content: '你是助手' }, A('你好')])
await send('连续两个 assistant', [U('hi'), A('一'), A('二'), U('只回答两个字：收到')])
await send('assistant 后接 system', [U('hi'), A('一'), { role: 'system', content: '补充' }, U('只回答两个字：收到')])
