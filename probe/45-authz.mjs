// 复现 403：Authorization 占位符 / 其它鉴权头组合
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
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(38)} HTTP ${res.status}  ${ok ? '' : text.slice(0, 120)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(38)} EXC ${e.message}`)
  }
}

console.log('=== Authorization 变体 ===')
await send('基线 (Bearer placeholder)', null)
await send('Bearer 真 token', h => { h['Authorization'] = `Bearer ${account.accessToken}` })
await send('去掉 Authorization', h => { delete h['Authorization'] })
await send('Authorization 空', h => { h['Authorization'] = '' })
await send('裸 token 无 Bearer', h => { h['Authorization'] = account.accessToken })

console.log('\n=== 模型槽位变体 ===')
for (const m of ['main-auto', 'deepseek-v4-pro-external', 'claude-sonnet-4-6', 'gpt-5.4', 'hy3-preview-agent-real', 'hunyuan-turbos-vision']) {
  const h = await marvisHeaders(account, { slot: m })
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers: h,
      body: JSON.stringify({ model: m, stream: false, max_tokens: 16, messages: [{ role: 'user', content: '只回答两个字：收到' }] }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    const ok = res.status === 200
    let served = ''
    try { served = JSON.parse(text)?.model ?? '' } catch {}
    console.log(`${ok ? '✓' : '✗'} ${m.padEnd(30)} HTTP ${res.status} served=${served}  ${ok ? '' : text.slice(0, 100)}`)
  } catch (e) {
    console.log(`✗ ${m.padEnd(30)} EXC ${e.message}`)
  }
}
