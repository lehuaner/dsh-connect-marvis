// 精确验证 BOM / NUL 在不同位置的表现
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

async function send(tag, body) {
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(40)} HTTP ${res.status} code=${code.padEnd(8)} ${text.slice(0, 60).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
  }
}

const mk = content => JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content }],
})

console.log('=== BOM (U+FEFF) 位置 ===')
await send('基线', mk('只回答两个字：收到'))
await send('BOM 在开头', '\uFEFF' + mk('只回答两个字：收到'))
await send('BOM 在 content 里', mk('只回答两个字：收到\uFEFF'))
await send('BOM 在 content 中间', mk('只回答\uFEFF两个字：收到'))
await send('BOM 转义为 \\ufeff', mk('只回答两个字：收到').replace('收到', '\\ufeff收到'))

console.log('\n=== NUL (U+0000) 位置 ===')
await send('NUL 在 content 里', mk('只回答两个字：收到\u0000'))
await send('NUL 转义 \\u0000', mk('只回答两个字：收到').replace('收到', '\\u0000收到'))
await send('NUL 在 body 结尾', mk('只回答两个字：收到') + '\u0000')

console.log('\n=== JSON.stringify 的实际输出 ===')
const withBom = mk('a\uFEFFb')
const withNul = mk('a\u0000b')
console.log('  含 BOM:', JSON.stringify(withBom))
console.log('  含 NUL:', JSON.stringify(withNul))

console.log('\n=== 其它控制字符 ===')
for (const [name, ch] of [['\\u0001', '\u0001'], ['\\u0007', '\u0007'], ['\\u001b(ESC)', '\u001b'], ['\\u007f(DEL)', '\u007f'], ['\\ufffe', '\ufffe'], ['\\ud800(孤立)', '\ud800']]) {
  await send(`content 含 ${name}`, mk(`只回答两个字：收到${ch}`))
}
