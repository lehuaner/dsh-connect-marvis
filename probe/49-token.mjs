// 复现 403「非法请求」：过期 token / 无效 token 的确切表现
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()

const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

async function send(tag, mutate) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  if (mutate) mutate(headers)
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(38)} HTTP ${res.status}  ${ok ? '' : text.slice(0, 150)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
  }
}

console.log('当前 token:', account.accessToken.slice(0, 10) + '…', 'len=', account.accessToken.length)
console.log()

console.log('=== token 变体 ===')
await send('基线', null)
await send('token 改一个字符', h => { h['Ual-Access-Access-Token'] = 'x' + account.accessToken.slice(1) })
await send('token = 空', h => { h['Ual-Access-Access-Token'] = '' })
await send('token 删除', h => { delete h['Ual-Access-Access-Token'] })
await send('token = 乱码', h => { h['Ual-Access-Access-Token'] = 'mv_invalidtoken123456789012345' })
await send('token = 旧格式', h => { h['Ual-Access-Access-Token'] = 'v1_' + 'a'.repeat(28) })

console.log('\n=== 组合：token 无效 + guid 无效 ===')
await send('两个都错', h => {
  h['Ual-Access-Access-Token'] = 'mv_bogus'
  h['Ual-Access-Guid'] = '0'.repeat(32)
})
