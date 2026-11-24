// 结构符合性：adapter 必须实现 LlmAdapter 抽象基类的全部方法
// （内核不做存在性检查，缺一个就 "is not a function"）
import { readFileSync } from 'node:fs'
import { MarvisAdapter } from '../src/adapter.js'

// 从 asar 里抽基类方法名太绕，直接按 src/index.ts 的定义列
const REQUIRED = [
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'imageRequestTarget',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
]

const adapter = new MarvisAdapter({})
const proto = Object.getPrototypeOf(adapter)
let failed = false
for (const name of REQUIRED) {
  const fn = proto[name]
  if (typeof fn === 'function') console.log(`  ✓ ${name}`)
  else { console.log(`  ✗ ${name} 缺失`); failed = true }
}

// 签名冒烟：内核调用方式下的返回值形状
const pricing = adapter.imageRequestPricing('marvis', 'main-auto')
console.log('  imageRequestPricing() =', pricing, '(应为 undefined)')
const target = adapter.imageRequestTarget('marvis', 'main-auto', { width: 100, height: 80, bytes: 1234 })
console.log('  imageRequestTarget()  =', JSON.stringify(target))
const prepared = await adapter.prepareCall('marvis', 'main-auto')
console.log('  prepareCall()         =', prepared.model.id, typeof prepared.stream)

if (failed) process.exit(1)
console.log('\n全部符合。')
