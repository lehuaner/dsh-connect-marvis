// 验收：一条命令检查插件是否可用（不需要打开 DSH）
//
//   node probe/verify.mjs
//
// 检查项：native 四件套 → qimei36 → 凭据 → 真实对话 → 工具调用
import { MarvisAdapter } from '../src/adapter.js'
import { fingerprintStatus } from '../src/fingerprint.js'
import { getAccount, refreshAccount, CREDENTIALS_PATH } from '../src/credentials.js'

const ok = text => console.log(`  ✓ ${text}`)
const bad = text => { console.log(`  ✗ ${text}`); process.exitCode = 1 }
const section = text => console.log(`\n${text}`)

let fatal = false

section('1. 设备指纹（不依赖客户端）')
const fp = fingerprintStatus()
if (fp.nativeReady) ok(`Beacon 已加载（${fp.nativeDir}）`)
else { bad(`Beacon 不可用：${fp.error}`); fatal = true }
if (fp.qimei36) ok(`qimei36 = ${fp.qimei36}`)
else { bad('qimei36 取不到 —— 需要打开过 Marvis 客户端'); fatal = true }
if (fp.clientVersion) ok(`clientVersion = ${fp.clientVersion}`)

section('2. 登录态')
let account
try {
  account = await getAccount()
  ok(`openid = ${account.openid.slice(0, 6)}…${account.openid.slice(-4)}`)
  ok(`guid = ${account.guid}`)
  ok(`来源 = ${account.server}`)
  ok(`refreshToken ${account.refreshToken !== '' ? `已就绪（${account.refreshToken.length} 字符）` : '缺失 —— 将无法自动续期'}`)
  if (account.expiresAt > 0) {
    const left = account.expiresAt - Date.now()
    if (left > 0) ok(`有效期还剩 ${Math.round(left / 60000)} 分钟`)
    else bad(`已过期 ${Math.round(-left / 60000)} 分钟`)
  }
} catch (error) {
  bad(error.message)
  fatal = true
}

if (fatal) {
  console.log('\n前置条件不满足，跳过网络测试。')
  process.exit(1)
}

section('3. 自动续期')
if (account.refreshToken === '') {
  bad('没有 refreshToken，跳过')
} else {
  try {
    const before = Math.round((account.expiresAt - Date.now()) / 60000)
    const next = await refreshAccount(account)
    const after = Math.round((next.expiresAt - Date.now()) / 60000)
    ok(`续期成功：${before} 分钟 → ${after} 分钟`)
    account = next
  } catch (error) {
    bad(`续期失败：${error.message}`)
  }
}

section('4. 真实对话')
const adapter = new MarvisAdapter({ debug: () => {} })
{
  const t0 = Date.now()
  let text = ''
  let finish = null
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis',
      model: 'main-auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }],
      maxTokens: 32,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind === 'stop' && text !== '') ok(`${Date.now() - t0}ms · ${text.trim().slice(0, 60)}`)
    else bad(`未正常结束：${JSON.stringify(finish)}`)
  } catch (error) {
    bad(`请求失败：${error.message}`)
  }
}

section('5. 工具调用')
{
  const calls = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis',
      model: 'main-auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '17 乘 23 是多少？必须调用 calculate。' }] }],
      tools: [{
        name: 'calculate',
        description: '计算数学表达式',
        parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      }],
      maxTokens: 200,
    })) {
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push(chunk.block)
    }
    if (calls.length > 0) ok(`${calls[0].name}(${calls[0].arguments})`)
    else bad('模型没有产生工具调用')
  } catch (error) {
    bad(`请求失败：${error.message}`)
  }
}

console.log(`\n凭据缓存：${CREDENTIALS_PATH}`)
console.log(process.exitCode === 1 ? '\n有检查项未通过。' : '\n全部通过。')
