// 复现 403：连续两条 system / system 与 developer 混用
import { MarvisAdapter } from '../src/adapter.js'

const adapter = new MarvisAdapter({ debug: () => {} })

async function tryIt(tag, opts) {
  let finish = null
  let text = ''
  try {
    for await (const chunk of adapter.stream({ provider: 'marvis', model: 'main-auto', maxTokens: 64, ...opts })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    const ok = finish?.kind === 'stop'
    console.log(`${ok ? '✓' : '✗'} ${tag.padEnd(40)} ${ok ? text.trim().slice(0, 14) : JSON.stringify(finish)}`)
  } catch (e) {
    console.log(`✗ ${tag.padEnd(40)} EXC ${e.message}`)
  }
}

const U = { role: 'user', content: [{ type: 'text', text: '只回答两个字：收到' }] }

console.log('=== system 组合 ===')
await tryIt('system 参数 + messages 里无 system', {
  system: '你是助手。', messages: [U],
})
await tryIt('system 参数 + messages 里有 system', {
  system: '你是助手A。',
  messages: [{ role: 'system', content: [{ type: 'text', text: '你是助手B。' }] }, U],
})
await tryIt('messages 里两条连续 system', {
  messages: [
    { role: 'system', content: [{ type: 'text', text: '规则一' }] },
    { role: 'system', content: [{ type: 'text', text: '规则二' }] },
    U,
  ],
})
await tryIt('developer 角色', {
  messages: [{ role: 'developer', content: [{ type: 'text', text: '开发者指令' }] }, U],
})
await tryIt('system 在中间', {
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: '中途插入的规则' }] },
    U,
  ],
})
