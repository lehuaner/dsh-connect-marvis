// 复现 403「非法请求」：MarvisExt 里 qimei36 / 其它字段为空或不一致
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'
import { qimei36Of, clientVersion } from '../src/fingerprint.js'

const account = await getAccount()
console.log('qimei36 =', JSON.stringify(qimei36Of()))
console.log('clientVersion =', JSON.stringify(clientVersion()))
console.log()

const BODY = JSON.stringify({
  model: 'main-auto', stream: false, max_tokens: 16,
  messages: [{ role: 'user', content: '只回答两个字：收到' }],
})

async function send(tag, mutateExt, mutateHeaders) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  if (mutateExt) {
    const ext = JSON.parse(headers['Ual-Access-MarvisExt'])
    mutateExt(ext)
    headers['Ual-Access-MarvisExt'] = JSON.stringify(ext)
  }
  if (mutateHeaders) mutateHeaders(headers)
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(60000) })
    const text = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(40)} HTTP ${res.status}  ${ok ? '' : text.slice(0, 140)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
  }
}

console.log('=== ext 字段扰动 ===')
await send('基线', null)
await send('qimei36 = ""', e => { e.qimei36 = '' })
await send('qimei36 删除', e => { delete e.qimei36 })
await send('qimei36 = 假值', e => { e.qimei36 = '0'.repeat(36) })
await send('originOpenID = ""', e => { e.originOpenID = '' })
await send('uskey = ""', e => { e.uskey = '' })
await send('uskey 删除', e => { delete e.uskey })
await send('nonce = ""', e => { e.nonce = '' })
await send('clientVersion = ""', e => { e.clientVersion = '' })
await send('reqScene 删除', e => { delete e.reqScene })

console.log('\n=== header 扰动 ===')
await send('guid 改错', null, h => { h['Ual-Access-Guid'] = '0'.repeat(32) })
await send('Login-Type = 2', null, h => { h['Ual-Access-Login-Type'] = '2' })
await send('openid 改错', null, h => { h['Ual-Access-Openid'] = 'oXXXXXXXX' })
