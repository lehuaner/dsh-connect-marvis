// 自测：直接跑适配器（不经过 DSH），验证流式 / 工具 / 错误处理
import { MarvisAdapter } from '../src/adapter.js'
import { resolveAccount } from '../src/credentials.js'
import { fingerprintStatus } from '../src/fingerprint.js'

const log = (...a) => console.log(...a)

log('=== 指纹 ===')
log(JSON.stringify(fingerprintStatus(), null, 2))

log('\n=== 凭据 ===')
let acct
try {
  acct = resolveAccount()
  log(JSON.stringify({ ...acct, accessToken: acct.accessToken.slice(0, 8) + '…' }, null, 2))
} catch (e) {
  log('凭据失败:', e.message)
  process.exit(1)
}

const adapter = new MarvisAdapter({ debug: m => log('  [debug]', m) })

log('\n=== listModels ===')
const models = await adapter.listModels('marvis')
log(`${models.length} 个:`, models.map(m => m.id).join(', '))

log('\n=== resolveModel(main-auto) ===')
log(JSON.stringify(await adapter.resolveModel('marvis', 'main-auto'), null, 2))

// ── 纯文本流 ────────────────────────────────────────────────
log('\n=== 流式对话 ===')
{
  const t0 = Date.now()
  let text = ''
  let usage = null
  let finish = null
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'marvis',
    model: 'main-auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: '用一句话介绍你自己' }] }],
    maxTokens: 200,
  })) {
    chunks.push(chunk.type)
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  log(`  用时 ${Date.now() - t0}ms  块事件: ${[...new Set(chunks)].join(',')}`)
  log(`  文本: ${text}`)
  log(`  usage: ${JSON.stringify(usage)}`)
  log(`  finish: ${JSON.stringify(finish)}`)
}

// ── 工具调用 ────────────────────────────────────────────────
log('\n=== 工具调用 ===')
{
  let text = ''
  const calls = []
  let finish = null
  for await (const chunk of adapter.stream({
    provider: 'marvis',
    model: 'main-auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: '北京天气如何？请调用工具。' }] }],
    tools: [{
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
    maxTokens: 300,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push(chunk.block)
    if (chunk.type === 'finish') finish = chunk.reason
  }
  log(`  文本: ${text || '(空)'}`)
  log(`  工具调用: ${JSON.stringify(calls)}`)
  log(`  finish: ${JSON.stringify(finish)}`)
}

// ── 多轮 + 工具结果回灌 ─────────────────────────────────────
log('\n=== 多轮（含工具结果） ===')
{
  let text = ''
  let finish = null
  for await (const chunk of adapter.stream({
    provider: 'marvis',
    model: 'main-auto',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '北京天气如何？' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call_abc', name: 'get_weather', arguments: '{"city":"北京"}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_abc', content: [{ type: 'text', text: '晴，18 度' }] },
    ],
    tools: [{
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
    maxTokens: 200,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason
  }
  log(`  文本: ${text}`)
  log(`  finish: ${JSON.stringify(finish)}`)
}

// ── 取消 ────────────────────────────────────────────────────
log('\n=== 取消 ===')
{
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 120)
  let finish = null
  try {
    for await (const chunk of adapter.stream({
      provider: 'marvis',
      model: 'main-auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: '写一篇 2000 字文章' }] }],
      signal: controller.signal,
    })) {
      if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (e) {
    log('  抛出:', e.message)
  }
  log(`  finish: ${JSON.stringify(finish)}`)
}
