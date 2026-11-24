// 静默等待恢复 → 再测 WAF 模式（纯文本「非法请求」的真正来源？）
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
const headers = await marvisHeaders(account, { slot: 'main-auto' })

async function hit(tag, content) {
  const body = JSON.stringify({
    model: 'main-auto', stream: false, max_tokens: 8,
    messages: [{ role: 'user', content }],
  })
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(40000) })
    const text = await res.text()
    let code = ''
    try { code = String(JSON.parse(text)?.code ?? '') } catch {}
    const isJson = text.trimStart().startsWith('{')
    console.log(`${res.status === 200 ? '✓' : '✗'} ${tag.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms HTTP ${res.status} ${code ? 'code=' + code : ''} ${isJson ? '' : '⚠纯文本'} ${text.slice(0, 70).replace(/\n/g, ' ')}`)
    return res.status === 200
  } catch (e) {
    console.log(`✗ ${tag.padEnd(30)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 静默等待 300 秒（不发任何请求）===')
for (let i = 1; i <= 10; i++) {
  await new Promise(r => setTimeout(r, 30000))
  process.stdout.write(`  ${i * 30}s... `)
}
console.log('\n等待结束')

console.log('\n=== 探一次，确认恢复 ===')
const recovered = await hit('恢复探测', '只回答两个字：收到')
if (!recovered) {
  console.log('仍未恢复，退出')
  process.exit(0)
}

console.log('\n=== WAF 敏感模式（间隔 4s，避免突发限流）===')
const patterns = [
  ['路径穿越', '看看这个路径 ../../../../etc/passwd 的内容'],
  ['rm -rf', '执行 rm -rf / 会怎样'],
  ['SQL 注入', "SELECT * FROM users WHERE name = ' OR '1'='1"],
  ['XSS', '<script>alert(1)</script>'],
  ['union select', 'a UNION SELECT password FROM admin'],
  ['base64 长串', 'A'.repeat(500)],
  ['shell 管道', 'cat /etc/passwd | grep root | awk -F: {print $1}'],
  ['中文字面量', '这句话里有非法请求三个字'],
  ['null 字节串', 'x\\u0000y'],
  ['超长重复', '哈'.repeat(2000)],
]
for (const [name, content] of patterns) {
  await hit(name, content)
  await new Promise(r => setTimeout(r, 4000))
}
