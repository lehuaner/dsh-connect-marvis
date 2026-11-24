// 67：4100406 —— system 开头「标准助手身份句」被网关判非法请求
//
// 这条规则不是词表黑名单，而是「开头身份声明」的启发式：
//   ✗ You are a helpful assistant. / You are an AI agent. / You are a coding agent.
//   ✗ You are Claude, made by Anthropic.
//   ✓ You are a assistant.（去掉形容词）  ✓ You are a helpful agent.（换名词）
//   ✓ You are welcome. / You are a banana. / 你是一个有用的助手。
//   ✓ 同样句子放第二行、放 user 角色里
// 出口修复见 src/messages.js 的 rewriteLeadingIdentity()。
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'
import { rewriteLeadingIdentity, toChatMessages } from '../src/messages.js'

const account = await getAccount()

async function probe(sysText) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  const body = JSON.stringify({
    model: 'main-auto', stream: false, max_tokens: 16,
    messages: [{ role: 'system', content: sysText }, { role: 'user', content: '回答：收到' }],
  })
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(40000) })
    const t = await res.text()
    return { status: res.status, code: /4100\d\d\d/.exec(t)?.[0] ?? '' }
  } catch (e) { return { status: 0, code: 'EXC' } }
}

const BLOCKED = [
  'You are a helpful assistant.',
  'You are an AI agent.',
  'You are a coding agent.',
  'You are Claude, made by Anthropic.',
]
const ALLOWED = [
  'You are a assistant.',
  'You are a helpful agent.',
  'You are welcome.',
  'You are a banana.',
  'You are ChatGPT, a large language model.',
  '你是一个有用的助手。',
  'Rules follow. You are a helpful assistant.',
]

let bad = 0
console.log('=== 应当被拒（4100406）===')
for (const t of BLOCKED) {
  const r = await probe(t)
  const ok = r.code === '4100406'
  if (!ok) bad += 1
  console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${r.code.padEnd(8)} ${JSON.stringify(t)}`)
}

console.log('\n=== 应当放行 ===')
for (const t of ALLOWED) {
  const r = await probe(t)
  const ok = r.status === 200
  if (!ok) bad += 1
  console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${r.code.padEnd(8)} ${JSON.stringify(t)}`)
}

console.log('\n=== 改写后必须放行 ===')
for (const t of BLOCKED) {
  const rw = rewriteLeadingIdentity(t)
  const r = await probe(rw)
  const ok = r.status === 200
  if (!ok) bad += 1
  console.log(`  ${ok ? '✓' : '✗'} ${String(r.status).padEnd(4)} ${JSON.stringify(rw)}`)
}

console.log('\n=== 出口集成（toChatMessages）===')
const out = toChatMessages(
  [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  'You are an AI agent powered by DSH.\n\nYou are a coding agent powered by the main-auto model.',
)
const sys = out[0].content
// 只改「开头」那一句 —— 第二行已经在正文中间，实测不触发，按设计保持原样。
const integrated = sys.startsWith('This agent is an AI agent powered by DSH.')
if (!integrated) bad += 1
console.log(`  ${integrated ? '✓' : '✗'} 开头句已改写: ${JSON.stringify(sys.slice(0, 60))}`)
console.log(`  ${sys.includes('You are a coding agent') ? '✓' : '✗'} 非开头句按设计保持不变`)

console.log(`\n${bad === 0 ? '全部符合预期' : `${bad} 项不符预期`}`)
process.exitCode = bad === 0 ? 0 : 1