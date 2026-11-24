// 验证 ensureUserTail 修复了所有角色形状
import { toChatMessages } from '../src/messages.js'
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

async function send(tag, rawMessages, system) {
  const msgs = toChatMessages(rawMessages, system, () => {})
  const body = JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16, messages: msgs })
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    const shape = msgs.map(m => m.role).join(',')
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(34)} [${shape}]`.padEnd(84) + ` HTTP ${res.status} ${code ? 'code=' + code : ''}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(34)} EXC ${e.message}`)
  }
}

const U = t => ({ role: 'user', content: [{ type: 'text', text: t }] })
const A = t => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
const AC = (id) => ({ role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }] })
const TR = (id, t) => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: t }] })

console.log('=== 修复后的各种形状 ===')
await send('正常 user 结尾', [U('只回答两个字：收到')])
await send('assistant 结尾', [U('hi'), A('你好')])
await send('只有 assistant', [A('你好')])
await send('只有 system', [], '你是助手')
await send('system + assistant', [A('你好')], '你是助手')
await send('连续两个 assistant', [U('hi'), A('一'), A('二')])
await send('assistant 后接 system', [U('hi'), A('一')])
await send('工具结果结尾', [U('读文件'), AC('c1'), TR('c1', '内容')])
await send('工具调用无结果', [U('读文件'), AC('c1')])
await send('空消息数组', [])
await send('截断后只剩 tool-result', [
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: '旧结果' }] }] },
])

console.log('\n=== 脏字符 + 形状组合 ===')
await send('NUL + assistant 结尾', [
  U('跑命令'),
  { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: '输出\u0000含NUL' }] },
  AC('c9'),
  A('处理完了\u001b[0m'),
])
