// 验证 native 自动发现：不依赖插件自带 native/，而是从 Marvis 客户端目录找
import { renameSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const NATIVE = 'native'
const HIDDEN = 'native__hidden'
const hadNative = existsSync(NATIVE)

function run(label, env = {}) {
  console.log(`\n===== ${label} =====`)
  try {
    const out = execFileSync(process.execPath, ['probe/verify.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    const lines = out.split('\n').filter((l) => l.includes('qimei36') || l.includes('真实对话') || l.includes('✓ 收到') || l.includes('nativeDir'))
    console.log(lines.slice(0, 6).join('\n') || out.trim().split('\n').slice(-3).join('\n'))
    console.log(`结果: ${out.includes('全部通过') ? '✓ 全部通过' : '✗ 未全通过'}`)
    return out.includes('全部通过')
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    const msg = out.split('\n').filter((l) => /✗|无法|失败|缺少|找不到/.test(l)).slice(0, 4).join('\n')
    console.log(msg || e.message.split('\n')[0])
    return false
  }
}

try {
  // 1) 把插件自带 native/ 藏起来，强制走客户端目录发现
  if (hadNative) renameSync(NATIVE, HIDDEN)
  console.log(`插件自带 native/ 已隐藏: ${!existsSync(NATIVE)}`)

  const auto = run('自动发现（无自带 native/，应去 Marvis 客户端目录找）')

  // 2) 显式指定应也能生效
  const explicit = run('显式 MARVIS_NATIVE_DIR', {
    MARVIS_NATIVE_DIR: 'D:\\Code\\Editer\\Marvis\\Application\\1.60.3600.59\\win32-native',
  })

  // 3) 指到不存在的目录应给出可操作的报错
  const bad = run('指向不存在的目录（应报错且说清去哪找）', { MARVIS_NATIVE_DIR: 'D:\\nope\\nope' })

  console.log(`\n自动发现=${auto ? '✓' : '✗'} 显式指定=${explicit ? '✓' : '✗'} 错误提示=${bad ? '✗(不该通过)' : '✓(正确报错)'}`)
  if (!auto || !explicit || bad) process.exitCode = 1
} finally {
  if (hadNative) {
    if (existsSync(HIDDEN)) renameSync(HIDDEN, NATIVE)
    console.log(`\n已恢复插件自带 native/: ${existsSync(NATIVE)}`)
  }
}