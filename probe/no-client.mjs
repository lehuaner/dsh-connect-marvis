// 诊断：确认插件在不依赖 Marvis 客户端的情况下可用
//
//   node probe/no-client.mjs
//
// 会报告当前有没有 Marvis 进程在跑，以及凭据/续期/对话是否正常。
import { getAccount, refreshAccount, CREDENTIALS_PATH } from '../src/credentials.js'
import { MarvisAdapter } from '../src/adapter.js'
import { fingerprintStatus } from '../src/fingerprint.js'
import { execFileSync } from 'node:child_process'

function clientProcesses() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Marvis*', '/FO', 'CSV', '/NH'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 10_000,
    }).toString('utf8')
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && line.startsWith('"'))
      .map(line => {
        const m = /^"([^"]+)","(\d+)"/.exec(line)
        return m ? `${m[1]} (${m[2]})` : line
      })
  } catch {
    return []
  }
}

const procs = clientProcesses()
console.log('Marvis 客户端进程:', procs.length === 0 ? '无 —— 完全脱离' : procs.join(', '))

console.log('\n指纹:')
const fp = fingerprintStatus()
console.log('  Beacon     =', fp.nativeReady ? '就绪' : `不可用（${fp.error}）`)
console.log('  qimei36    =', fp.qimei36 || '(缺失)')
console.log('  clientVer  =', fp.clientVersion)

console.log('\n凭据:')
const account = await getAccount()
console.log('  来源        =', account.server)
console.log('  refreshToken=', account.refreshToken !== '' ? `就绪（${account.refreshToken.length} 字符）` : '缺失')
console.log('  剩余        =', account.expiresAt > 0 ? `${Math.round((account.expiresAt - Date.now()) / 60000)} 分钟` : '未知')

console.log('\n续期:')
try {
  const next = await refreshAccount(account)
  console.log('  ✓ 成功，新的剩余 =', Math.round((next.expiresAt - Date.now()) / 60000), '分钟')
} catch (error) {
  console.log('  ✗ 失败：', error.message)
  process.exitCode = 1
}

console.log('\n对话:')
const adapter = new MarvisAdapter({ debug: () => {} })
let text = ''
let finish = null
for await (const chunk of adapter.stream({
  provider: 'marvis',
  model: 'main-auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: '说一句：我不需要客户端' }] }],
  maxTokens: 40,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk.reason
}
if (finish?.kind === 'stop' && text !== '') console.log('  ✓', text.trim().slice(0, 80))
else {
  console.log('  ✗', JSON.stringify(finish))
  process.exitCode = 1
}

console.log(`\n凭据缓存: ${CREDENTIALS_PATH}`)
