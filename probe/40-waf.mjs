// 复现 403：网关 WAF 是否扫描请求体内容
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()

async function send(tag, text) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  const t0 = Date.now()
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'main-auto', stream: false, max_tokens: 16,
        messages: [{ role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    const body = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(34)} HTTP ${res.status} ${Date.now() - t0}ms  ${ok ? '' : body.slice(0, 160)}`)
    return ok
  } catch (e) {
    console.log(`✗ ${tag.padEnd(34)} EXC ${e.message}`)
    return false
  }
}

console.log('=== 内容触发 WAF？ ===')
await send('基线（正常文本）', '只回答两个字：收到')
await send('含网关域名', '这段文字提到 yybadaccess.3g.qq.com 这个地址。只回答：收到')
await send('含 Ual-Access 头名', '日志里出现了 Ual-Access-MarvisExt 和 Ual-Access-Login-Type 两个头。只回答：收到')
await send('含 access_token 样式', '参数是 access_token=mv_0123456789abcdef0123456789abcdef 。只回答：收到')
await send('含 refreshToken 样式', '{"refreshToken":"v1_abc123def456ghi789jkl012mno345pqr678stu901vwx234yz"}. 只回答：收到')
await send('含 Authorization Bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc 。只回答：收到')
await send('含 qimei36 长hex', '设备号 0123456789abcdef0123456789abcdef0123 已上报。只回答：收到')

console.log('\n=== 非法字节 ===')
await send('含 NUL 字符', '前面\x00后面。只回答：收到')
await send('孤立代理字符', '前面\ud800后面。只回答：收到')
await send('含控制字符', '前面\x01\x02\x1b[31m后面。只回答：收到')
