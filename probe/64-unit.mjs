// 单元验证 describeFailure 新映射 + 退避取消行为
import { describeFailure } from '../src/protocol.js'
import { toChatMessages, sanitizeText } from '../src/messages.js'

console.log('=== describeFailure 映射 ===')
const cases = [
  [403, '{"code":4100404,"msg":"客户端通用错误:请求被风控拦截"}'],
  [400, '{"code":4100400,"msg":"客户端通用错误:非法请求"}'],
  [401, '{"code":4100403,"msg":"登录态失效"}'],
  [400, '{"code":4130001,"msg":"无效模型id"}'],
  [429, '{"code":429,"msg":"too many"}'],
  [500, '{"code":5104002,"msg":"RPC调用报错"}'],
  [403, '非法请求'],
  [502, 'Bad Gateway'],
]
for (const [status, text] of cases) {
  const f = describeFailure(status, text)
  console.log(`  ${String(status).padStart(3)} ${f.code.padEnd(22)} retry=${String(f.retryable).padEnd(5)} ${f.message.slice(0, 62)}`)
}

console.log('\n=== sanitizeText 幂等性 ===')
const dirty = 'a\u0000b\u001bc\uFEFFd\uD800e\n\t正常'
const once = sanitizeText(dirty)
const twice = sanitizeText(once)
console.log(`  原始: ${JSON.stringify(dirty)}`)
console.log(`  一次: ${JSON.stringify(once)}`)
console.log(`  二次: ${JSON.stringify(twice)}  幂等=${once === twice}`)

console.log('\n=== ensureUserTail 各类形状 ===')
const U = t => ({ role: 'user', content: [{ type: 'text', text: t }] })
const A = t => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
const shapes = [
  ['空', []],
  ['只有 user', [U('hi')]],
  ['user+assistant', [U('hi'), A('好')]],
  ['只有 assistant', [A('好')]],
  ['两 assistant 连排', [U('hi'), A('一'), A('二')]],
  ['tool 结尾', [U('读'), { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'x' }] }]],
  ['assistant+tool', [U('读'), A('好'), { role: 'tool', toolCallId: 'c', content: [{ type: 'text', text: 'x' }] }]],
]
for (const [name, msgs] of shapes) {
  const out = toChatMessages(msgs, undefined, () => {})
  console.log(`  ${name.padEnd(20)} -> [${out.map(m => m.role).join(',')}]`)
}
