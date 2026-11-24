// 复现 403：工具消息配对不完整（真实会话截断后极易出现）
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'
import { toChatMessages } from '../src/messages.js'

const account = await getAccount()

async function send(tag, messages) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'main-auto', stream: false, max_tokens: 16, messages }),
      signal: AbortSignal.timeout(60000),
    })
    const body = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(44)} HTTP ${res.status}  ${ok ? '' : body.slice(0, 130)}`)
    return ok
  } catch (e) {
    console.log(`✗ ${tag.padEnd(44)} EXC ${e.message}`)
    return false
  }
}

const U = { role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }

console.log('=== 直接构造（绕过投影）===')

// 1) 孤立的 tool 消息（前面没有 assistant tool_calls）
await send('孤立 tool（无对应 assistant）', [
  { role: 'tool', tool_call_id: 'call_x', content: '结果' },
  U,
])

// 2) assistant 有 tool_calls 但缺 tool 响应
await send('assistant tool_calls 缺响应', [
  { role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  U,
])

// 3) tool_call_id 对不上
await send('tool_call_id 不匹配', [
  { role: 'user', content: '读文件' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_OTHER', content: '结果' },
  U,
])

// 4) assistant content 为 null 且无 tool_calls
await send('assistant content=null 无调用', [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null },
  U,
])

// 5) 空 content 字符串
await send('空 content 字符串', [
  { role: 'user', content: '' },
  U,
])

console.log('\n=== 经 toChatMessages 投影（模拟真实历史被截断）===')

// 会话截断后：只剩一条带 tool-result 块的 user 消息
const truncated = toChatMessages([
  { role: 'user', content: [
    { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '文件内容' }] },
    { type: 'text', text: '继续' },
  ] },
  { role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] },
], undefined, () => {})
console.log('  投影结果:', JSON.stringify(truncated).slice(0, 260))
await send('截断后孤立 tool（经投影）', truncated)
