// 复现 403：请求头被宿主环境覆盖（UA / Origin / Cookie）
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
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers, body: BODY, signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    const ok = res.status === 200
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(40)} HTTP ${res.status}  ${ok ? '' : text.slice(0, 120)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
  }
}

console.log('=== UA 变体 ===')
await send('基线 UA', null)
await send('UA = Electron', h => { h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DeepSeek Harness/0.2.2 Chrome/130.0.6723.152 Electron/33.2.0 Safari/537.36' })
await send('UA = 浏览器', h => { h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36' })
await send('UA = 空', h => { delete h['User-Agent'] })

console.log('\n=== 额外头 ===')
await send('+ Origin', h => { h['Origin'] = 'file://' })
await send('+ Cookie', h => { h['Cookie'] = 'logintype=WX; uin=o12345' })
await send('+ Referer', h => { h['Referer'] = 'https://marvis.qq.com/' })
await send('+ sec-fetch-*', h => {
  h['Sec-Fetch-Site'] = 'none'; h['Sec-Fetch-Mode'] = 'cors'; h['Sec-Fetch-Dest'] = 'empty'
})

console.log('\n=== 缺失关键头 ===')
await send('去掉 Ual-Access-Login-Type', h => { delete h['Ual-Access-Login-Type'] })
await send('去掉 Marvis-Scene', h => { delete h['Marvis-Scene'] })
await send('去掉 Content-Type', h => { delete h['Content-Type'] })
