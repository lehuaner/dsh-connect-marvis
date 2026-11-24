// 验证清洗是否真的修好了 4100400 / 4100404
import { MarvisAdapter } from '../src/adapter.js'
import { toChatMessages, sanitizeText } from '../src/messages.js'
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

console.log('=== sanitizeText 单元行为 ===')
const cases = [
  ['NUL', 'a\u0000b'],
  ['ESC', 'a\u001bb'],
  ['DEL', 'a\u007fb'],
  ['BOM', 'a\uFEFFb'],
  ['U+FFFE', 'a\uFFFEB'],
  ['孤立高位', 'a\uD800b'],
  ['孤立低位', 'a\uDC00b'],
  ['保留 \\n\\t', 'a\n\tb'],
  ['保留中文emoji', '收到🚀'],
  ['正常文本', '这是正常文本'],
]
for (const [name, input] of cases) {
  const out = sanitizeText(input)
  const changed = out !== input
  console.log(`  ${name.padEnd(14)} ${JSON.stringify(input)} -> ${JSON.stringify(out)} ${changed ? '（已清洗）' : ''}`)
}

console.log('\n=== 脏数据经完整投影后再发请求 ===')
async function trySend(tag, rawMessages) {
  const msgs = toChatMessages(rawMessages, undefined, () => {})
  const body = JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16, messages: msgs })
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(38)} HTTP ${res.status} code=${code.padEnd(8)} ${text.slice(0, 55).replace(/\n/g, ' ')}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
  }
}

const U = t => ({ role: 'user', content: [{ type: 'text', text: t }] })

await trySend('纯净对照', [U('只回答两个字：收到')])
await trySend('工具输出含 NUL', [
  U('读文件'),
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '文件内容\u0000有NUL' }] },
  U('只回答两个字：收到'),
])
await trySend('工具输出含 ESC', [
  U('跑命令'),
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: '\u001b[31m红色\u001b[0m输出' }] },
  U('只回答两个字：收到'),
])
await trySend('user 文本含 BOM 开头', [U('\uFEFF只回答两个字：收到')])
await trySend('最后一条是 assistant 收尾', [
  U('只回答两个字：收到'),
  { role: 'assistant', content: [{ type: 'text', text: '收到\u0000' }] },
])
