// 检查并发出票是否稳定（Beacon 可能不是线程安全的）
import { randomUUID } from 'node:crypto'
import { marvisHeaders, CHAT_URL } from '../src/protocol.js'
import { getAccount } from '../src/credentials.js'

const account = await getAccount()
console.log('账号:', account.openid, 'guid:', account.guid)

const IDENTITY = '你是功能强大的 AI 助手。'

async function call(i) {
  const headers = await marvisHeaders(account, { slot: 'main-auto' })
  const ext = JSON.parse(headers['Ual-Access-MarvisExt'])
  const uskeyLen = ext.uskey?.length ?? 0
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST', headers,
      body: JSON.stringify({
        model: 'main-auto', stream: false, max_tokens: 16,
        messages: [{ role: 'system', content: IDENTITY }, { role: 'user', content: `收到(${i})` }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    const t = await res.text()
    return { i, status: res.status, uskeyLen, body: t.slice(0, 100) }
  } catch (e) {
    return { i, status: -1, uskeyLen, err: e.message }
  }
}

console.log('\n=== 并发 8 个（每个独立出票）===')
const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call(i)))
for (const r of results) {
  console.log(`  ${r.status === 200 ? '✓' : '✗'} #${r.i} HTTP ${r.status} uskeyLen=${r.uskeyLen} ${r.status !== 200 ? r.body ?? r.err : ''}`)
}

console.log('\n=== 顺序 5 个 ===')
for (let i = 0; i < 5; i++) {
  const r = await call(100 + i)
  console.log(`  ${r.status === 200 ? '✓' : '✗'} #${r.i} HTTP ${r.status} uskeyLen=${r.uskeyLen} ${r.status !== 200 ? r.body ?? r.err : ''}`)
}
