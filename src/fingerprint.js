/**
 * 设备指纹 —— uskey 与 qimei36。
 *
 * 2026-11-17 之后，`/v1/chat/completions` 会校验 `MarvisExt.uskey` 是否由
 * 官方 Beacon SDK 按**本次请求的 busInfo** 现算。随机串一上来就 4100404，
 * 所以这里必须加载 native/ 里的 `beacon_napi.node`。
 *
 * qimei36 不是算出来的，是设备在腾讯侧登记过的 36 位 hex。它落在
 * Marvis 客户端的日志里（`解析登录信息成功 ... qimei36=Some("...")`），
 * 也印在 YanvisHost 的每个进程启动行里 —— 直接从日志抠真值最稳，
 * 不依赖 Beacon 的 getQimei（本机实测 Beacon 的 init 在客户端进程里也失败）。
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))

/** Beacon 四件套 —— beacon_napi.node 靠同目录兄弟 DLL 动态加载，少一个就崩 */
const REQUIRED = ['beacon_napi.node', 'qimei.dll', 'beacon_sdk.dll', 'beacon_wrapper.dll']

/**
 * Marvis 客户端的候选安装目录。
 *
 * 四个 native 文件是**腾讯客户端自带的**，不属于本插件，所以仓库里不带它们
 * （体积 11 MB、且是别人的二进制）。用户装了客户端，这几份就在
 * `<安装目录>/Application/<版本号>/win32-native/` 下面，这里按优先级去捞：
 *
 *   1. `MARVIS_NATIVE_DIR` —— 显式指定，最优先（也用于搬机器/自定义安装）
 *   2. 插件自带的 `native/` —— 老用户手工拷过，或将来 dev 版打包进去
 *   3. 客户端默认安装目录，扫 `Application/*` 取版本号最高的一个
 *
 * 都找不到就报错，并把「去哪儿找」直接写进错误信息。
 */
const CLIENT_ROOTS = [
  'D:\\Code\\Editer\\Marvis',
  'C:\\Program Files\\Marvis',
  'C:\\Program Files (x86)\\Marvis',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Marvis'),
]

/**
 * 目录里四个文件齐全吗。
 * @param {string} dir
 * @returns {boolean}
 */
function hasAll(dir) {
  return REQUIRED.every(name => existsSync(join(dir, name)))
}

/**
 * 扫客户端根目录下的 `Application/<version>/win32-native`，取版本最高的。
 * @param {string} root
 * @returns {string | null}
 */
function newestUnderApplication(root) {
  const appDir = join(root, 'Application')
  if (!existsSync(appDir)) return null
  let versions
  try {
    versions = readdirSync(appDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return null
  }
  // 版本号是点分数字，按数值逐段比较；非纯数字目录排到最后
  const weight = (name) => name.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : -1))
  versions.sort((a, b) => {
    const left = weight(a)
    const right = weight(b)
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const diff = (right[i] ?? -1) - (left[i] ?? -1)
      if (diff !== 0) return diff
    }
    return 0
  })
  for (const version of versions) {
    const candidate = join(appDir, version, 'win32-native')
    if (hasAll(candidate)) return candidate
  }
  return null
}

/**
 * 解析出真正要用的 native 目录，只算一次。
 * @returns {string}
 */
function resolveNativeDir() {
  const explicit = process.env.MARVIS_NATIVE_DIR
  if (explicit !== undefined && explicit !== '') return explicit

  const bundled = join(HERE, '..', 'native')
  if (hasAll(bundled)) return bundled

  for (const root of CLIENT_ROOTS) {
    if (root === '') continue
    const found = newestUnderApplication(root)
    if (found !== null) return found
  }
  // 全都没找到：返回默认位置，让上层错误信息说清楚该往哪放
  return bundled
}

const NATIVE_DIR = resolveNativeDir()

/** 上游 appKey（来自 Marvis resources/.env 的 MARVIS_QIMEI_APPKEY） */
const APP_KEY = '0WIN06Y06DKV1IUQ'
/** Beacon 初始化版本；跟客户端大版本一致即可 */
const APP_VERSION = '1.60.3600.59'
/** native SDK 的业务 id（注意：不是 /v3 的 marvis_client） */
const BUS_ID = 'marvis'

/** @type {any} */
let beacon = null
let beaconTried = false
let beaconError = ''
let qimeiCache = ''
let versionCache = ''

/**
 * 加载 Beacon。失败不抛 —— 让上层能给出「缺 native/」的明确提示。
 * @returns {any | null}
 */
function loadBeacon() {
  if (beaconTried) return beacon
  beaconTried = true
  try {
    const missing = REQUIRED.filter(name => !existsSync(join(NATIVE_DIR, name)))
    if (missing.length > 0) {
      beaconError =
        `找不到 Marvis 客户端自带的设备指纹组件（缺 ${missing.join(' / ')}，当前目录 ${NATIVE_DIR}）。` +
        `这些文件随客户端安装：<Marvis 安装目录>\\Application\\<版本>\\win32-native\\。` +
        `装好客户端后重启 DSH 即可自动找到；装在非默认位置时，用环境变量 ` +
        `MARVIS_NATIVE_DIR 指向那个 win32-native 目录。`
      return null
    }
    const mod = require(join(NATIVE_DIR, 'beacon_napi.node'))
    // 真实签名是 init(appKey, appVersion)，不是 init({appKey, appVersion})
    try {
      mod.init(APP_KEY, APP_VERSION)
    } catch (error) {
      beaconError = `Beacon init 失败：${error?.message ?? error}`
    }
    beacon = mod
    return mod
  } catch (error) {
    beaconError = `Beacon 加载失败：${error?.message ?? error}`
    return null
  }
}

/**
 * 按本次请求上下文出一张 uskey。
 * @param {string} busInfo 七段式请求上下文，不能为空
 * @returns {Promise<string>}
 */
export async function getUskey(busInfo) {
  if (!busInfo) throw new Error('getUskey 需要 busInfo')
  const mod = loadBeacon()
  if (mod !== null && typeof mod.getUskey === 'function') {
    const ticket = String(mod.getUskey(BUS_ID, busInfo) ?? '').trim()
    if (ticket !== '' && ticket !== 'null') return ticket
    beaconError = beaconError || 'getUskey 返回空'
  }
  throw new Error(`Marvis 设备指纹出票失败：${beaconError || 'Beacon 不可用'}。`)
}

/** Marvis 客户端数据目录候选 */
function clientRoots() {
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.TEMP].filter(Boolean)
  return bases.flatMap(base => [
    join(String(base), 'Tencent', 'Marvis'),
    join(String(base), 'Marvis'),
  ])
}

/**
 * 从客户端日志里抠 qimei36。
 *
 * `MarvisHost.log` 里每个进程启动都会打一行：
 *   `解析登录信息成功 ... qimei36=Some("0123456789abcdef0123456789abcdef0123")`
 * 这个值绑设备，读一次缓存住即可。
 * @returns {string}
 */
function detectQimei() {
  for (const root of clientRoots()) {
    if (!existsSync(root)) continue
    const found = scanForQimei(root, 0)
    if (found !== '') return found
  }
  return ''
}

const QIMEI_RX = /qimei36\W{0,3}([0-9a-f]{36,40})\b/i
const SKIP_DIR = /(Cache|GPUCache|Code Cache|Crashpad|node_modules)/i
const MAX_FILE = 16 * 1024 * 1024

function scanForQimei(dir, depth) {
  if (depth > 5) return ''
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue
      const hit = scanForQimei(full, depth + 1)
      if (hit !== '') return hit
      continue
    }
    // 只扫日志与文本，二进制里也有可能是随机巧合
    if (!/\.(log|txt|json)$/i.test(entry.name)) continue
    try {
      if (statSync(full).size > MAX_FILE) continue
      const text = readFileSync(full, 'utf8')
      const match = QIMEI_RX.exec(text)
      if (match !== null) return match[1]
    } catch {
      /* 单文件读不了就跳过 */
    }
  }
  return ''
}

/**
 * 设备 qimei36。
 *
 * 优先级：环境变量 → native/qimei36.txt → 客户端日志真值 → Beacon.getQimei()。
 * 全都拿不到就返回空串，由调用方决定是否省略该字段（省略会被风控，但不会崩）。
 * @returns {string}
 */
export function qimei36Of() {
  if (qimeiCache !== '') return qimeiCache

  const env = String(process.env.MARVIS_QIMEI36 ?? '').trim()
  if (env !== '') {
    qimeiCache = env
    return env
  }

  for (const name of ['qimei36.txt', 'qimei.txt']) {
    try {
      const value = readFileSync(join(NATIVE_DIR, name), 'utf8').trim()
      if (value !== '') {
        qimeiCache = value
        return value
      }
    } catch {
      /* 没有这个文件 */
    }
  }

  const fromClient = detectQimei()
  if (fromClient !== '') {
    qimeiCache = fromClient
    return fromClient
  }

  const mod = loadBeacon()
  if (mod !== null && typeof mod.getQimei === 'function') {
    try {
      const value = String(mod.getQimei() ?? '').trim()
      if (value !== '') {
        qimeiCache = value
        return value
      }
    } catch {
      /* 只能用空值了 */
    }
  }
  return ''
}

/**
 * 客户端版本号。
 *
 * 上游 MarvisExt 里带的是 `clientVersion`，官方客户端用的是自己实际的安装版本。
 * 从安装目录里挑一个版本号最大的，拿不到就用兜底常量。
 * @returns {string}
 */
export function clientVersion() {
  if (versionCache !== '') return versionCache

  const env = String(process.env.MARVIS_CLIENT_VERSION ?? '').trim()
  if (env !== '') {
    versionCache = env
    return env
  }

  // Marvis 装在 <base>\Tencent\Marvis\Application\<version>\win32-native
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, 'D:\\Code\\Editer'].filter(Boolean)) {
    const appDir = join(String(base), 'Tencent', 'Marvis', 'Application')
    const alt = join(String(base), 'Marvis', 'Application')
    for (const dir of [appDir, alt]) {
      if (!existsSync(dir)) continue
      try {
        const versions = readdirSync(dir)
          .filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
          .sort((a, b) => {
            const pa = a.split('.').map(Number)
            const pb = b.split('.').map(Number)
            for (let i = 0; i < 4; i += 1) if (pa[i] !== pb[i]) return pb[i] - pa[i]
            return 0
          })
        if (versions.length > 0) {
          versionCache = versions[0]
          return versionCache
        }
      } catch {
        /* 目录不可读就换下一个 */
      }
    }
  }

  versionCache = APP_VERSION
  return versionCache
}

/** 诊断信息，给设置面板用 */
export function fingerprintStatus() {
  const mod = loadBeacon()
  return {
    nativeReady: mod !== null,
    nativeDir: NATIVE_DIR,
    qimei36: qimei36Of(),
    clientVersion: clientVersion(),
    error: beaconError,
  }
}
