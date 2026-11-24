/**
 * 凭据来源 —— 从本机 Marvis 客户端"借"一次登录态，之后自己续期。
 *
 * ## 为什么能做到脱离客户端
 *
 * Marvis 的 access_token 只有 **2 小时**（微信登录 `expires_in: 7200`），
 * 但续期接口 `POST /marvis_client/marvis_refresh_token` 只要 `refreshToken`
 * 就能换新的有效期，而且 refreshToken 本身**很长命**。
 *
 * 所以策略是：
 *   1. 客户端在的时候，把 (openid, accessToken, guid, refreshToken) 一次性抓下来
 *   2. 之后自己每隔 ~100 分钟续期一次，永不回头找客户端
 *   3. 续期成功就写进 `~/.dsh/marvis-credentials.json`，重启也不丢
 *
 * 抓取来源只有日志（`MarvisHost.log`）—— 客户端运行时会以**不共享**模式独占
 * `Network/Cookies`，连只读句柄、copyFile、VSS 快照副本都拿不到（实测全 EBUSY
 * 或副本截断）。而日志里这几个值都是明文，且每次登录/续期都会重打一遍。
 *
 * 优先级：
 *   1. 环境变量（MARVIS_OPENID / MARVIS_ACCESS_TOKEN / MARVIS_GUID / MARVIS_REFRESH_TOKEN）
 *   2. 本地缓存（含上次续期的 refreshToken）
 *   3. Marvis 客户端日志（首次抓取）
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 缓存文件 —— 跟 DSH 的其它状态放一起 */
const CACHE = join(homedir(), '.dsh', 'marvis-credentials.json')

/** 续期接口 —— 注意不是仓库写的 marvis_client_login，那个是历史遗留，实测同样可用 */
const REFRESH_URL = 'https://yybadaccess.3g.qq.com/marvis_client_login/marvis_refresh_token'
/** /v3 业务接口签名用的 accessKey（逆向自渲染层） */
const ACCESS_KEY = 'fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi'
const BUSINESS_ID = 'marvis_client'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 上游给的 token 寿命（秒）。微信实测 7200，留 15% 余量提前续 */
const TOKEN_TTL_SEC = 7200
const REFRESH_LEAD_MS = TOKEN_TTL_SEC * 1000 * 0.15

/**
 * @typedef {object} Account
 * @property {string} openid
 * @property {string} accessToken
 * @property {string} guid
 * @property {string} refreshToken
 * @property {number} expiresAt 毫秒时间戳；0 表示未知
 * @property {string} loginType 恒为 6（见 protocol.js 文件头）
 * @property {string} server 数据来源，诊断用
 */

/** 从环境变量读，给 CI / 手动排障 / 完全无客户端部署用 */
function fromEnv() {
  const openid = String(process.env.MARVIS_OPENID ?? '').trim()
  const accessToken = String(process.env.MARVIS_ACCESS_TOKEN ?? '').trim()
  const guid = String(process.env.MARVIS_GUID ?? '').trim()
  if (openid === '' || accessToken === '' || guid === '') return null
  return {
    openid,
    accessToken,
    guid,
    refreshToken: String(process.env.MARVIS_REFRESH_TOKEN ?? '').trim(),
    expiresAt: Number(process.env.MARVIS_EXPIRES_AT ?? 0) || 0,
    loginType: '6',
    server: 'env',
  }
}

/** 读本地缓存（含上次续期拿到的 refreshToken） */
function fromCache() {
  if (!existsSync(CACHE)) return null
  try {
    const json = JSON.parse(readFileSync(CACHE, 'utf8'))
    if (typeof json?.openid !== 'string' || typeof json?.accessToken !== 'string') return null
    if (typeof json?.guid !== 'string' || json.guid === '') return null
    return {
      openid: json.openid,
      accessToken: json.accessToken,
      guid: json.guid,
      refreshToken: typeof json.refreshToken === 'string' ? json.refreshToken : '',
      expiresAt: Number(json.expiresAt ?? 0) || 0,
      loginType: '6',
      server: 'cache',
    }
  } catch {
    return null
  }
}

/**
 * 写缓存，失败不影响主流程。
 * @param {Account} account
 */
export function saveCredentials(account) {
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    writeFileSync(
      CACHE,
      JSON.stringify(
        {
          openid: account.openid,
          accessToken: account.accessToken,
          guid: account.guid,
          refreshToken: account.refreshToken ?? '',
          expiresAt: account.expiresAt ?? 0,
          savedAt: Date.now(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    )
    return true
  } catch {
    return false
  }
}

/** 客户端日志目录候选（真实位置：%TEMP%\Tencent\Marvis\logs\） */
function logDirs() {
  const bases = [process.env.TEMP, process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)
  const out = []
  for (const base of bases) {
    out.push(join(String(base), 'Tencent', 'Marvis', 'logs'))
    out.push(join(String(base), 'Marvis', 'logs'))
  }
  return out
}

/** 登录四元组：字段最全的那一行（agent 实际用的请求头） */
const RE_LOGIN_ARGS =
  /"Ual-Access-Access-Token":"([^"]+)"[^\n]*?"Ual-Access-Guid":"([^"]+)"[^\n]*?"Ual-Access-Openid":"([^"]+)"/g
/** 到期时间（秒级时间戳） */
const RE_PARSED = /open_id=([0-9A-Za-z_-]{16,64}) login_type=\w+ guid=([0-9a-fA-F]{32}) expire_time=(\d{9,11})/g
/** refreshToken —— 渲染层登录回调里带 */
const RE_REFRESH = /"refreshToken":"([^"]{20,})"/g

/**
 * 从日志文本里取最后一个（也就是最新的）登录态。
 * @param {string} text
 * @returns {Account | null}
 */
function parseLog(text) {
  let latest = null
  for (const match of text.matchAll(RE_LOGIN_ARGS)) {
    latest = { accessToken: match[1], guid: match[2], openid: match[3] }
  }
  if (latest === null) return null

  // 抓同一份 openid 的 expire_time（可能比 login_args 行更新）
  let expiresAt = 0
  for (const match of text.matchAll(RE_PARSED)) {
    if (match[1] === latest.openid && match[2].toLowerCase() === latest.guid.toLowerCase()) {
      expiresAt = Number(match[3]) * 1000
    }
  }

  // refreshToken 取最后一个 —— 续期时客户端可能换新
  let refreshToken = ''
  for (const match of text.matchAll(RE_REFRESH)) {
    if (match[1] !== '[REDACTED]') refreshToken = match[1]
  }

  return {
    openid: latest.openid,
    accessToken: latest.accessToken,
    guid: latest.guid.toLowerCase(),
    refreshToken,
    expiresAt,
    loginType: '6',
    server: 'client-log',
  }
}

/**
 * 从客户端日志读登录态。
 * 多个日志文件取 mtime 最新的那个；同一文件内取最后一次打印。
 * @returns {Account | null}
 */
function fromClientLog() {
  /** @type {Array<{file: string, mtime: number}>} */
  const candidates = []
  for (const dir of logDirs()) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        if (!/^Marvis(Host)?\.log$/i.test(name)) continue
        const full = join(dir, name)
        candidates.push({ file: full, mtime: statSync(full).mtimeMs })
      }
    } catch {
      /* 目录不可读 */
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  for (const { file } of candidates) {
    try {
      const account = parseLog(readFileSync(file, 'utf8'))
      if (account !== null) return account
    } catch {
      /* 单文件读不了就换下一个 */
    }
  }
  return null
}

/** /v3 业务接口签名：md5(query + timestamp + accessKey + nonce) */
function ualSignature(query, timestamp, nonce) {
  return createHash('md5').update(query + timestamp + ACCESS_KEY + nonce).digest('hex')
}

/**
 * 续期 —— 用 refreshToken 换新的有效期。
 *
 * 上游行为（实测）：
 *   · `access_token` **不变**，只重置有效期
 *   · `refresh_token` 回空串，表示"没给新值"，必须回退用旧的
 *   · `expires_in` 是字符串 "7200"
 *
 * @param {Account} account
 * @returns {Promise<Account>} 续期后的账号（accessToken 可能与原来相同）
 */
export async function refreshAccount(account) {
  const token = String(account.refreshToken ?? '')
  if (token === '') throw new Error('没有 refreshToken，无法续期')

  const body = JSON.stringify({
    userInfo: {
      openId: account.openid,
      refreshToken: token,
      accessToken: account.accessToken,
      // ⚠ 恒为 "Marvis"：不是 Ual-Access-Login-Type（那个是 6）
      loginType: 'Marvis',
    },
  })

  const timestamp = String(Date.now())
  const nonce = String(1000 + Math.floor(Math.random() * 9000))
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': BROWSER_UA,
    'Ual-Access-Businessid': BUSINESS_ID,
    'Ual-Access-Timestamp': timestamp,
    'Ual-Access-Nonce': nonce,
    'Ual-Access-Signature': ualSignature(body, timestamp, nonce),
    'Ual-Access-Guid': account.guid,
    'Ual-Access-Access-Token': account.accessToken,
    'Ual-Access-Login-Type': '6',
    'Ual-Access-Openid': account.openid,
  }

  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  })

  const text = await response.text()
  /** @type {any} */
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`续期接口返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }

  const info = json?.user_info ?? null
  const code = Number(json?.code ?? -1)

  if (code !== 0 || info === null) {
    const message = String(json?.msg ?? text.slice(0, 200))
    const error = new Error(`Marvis 续期失败（code=${code}）：${message}`)
    // -107 / -101 是「登录态真的不能用了」，其余是参数问题
    error.signIn = code === -107 || code === -101 ? 'expired' : 'error'
    throw error
  }

  // ⚠ access_token 可能回空串（没换新），必须回退
  const accessToken = String(info.access_token ?? '') || account.accessToken
  // ⚠ refresh_token 实测回空串，表示"这次没给新值"，不能当成清空
  const refreshToken = String(info.refresh_token ?? '') || account.refreshToken
  const ttlSec = Number(info.expires_in ?? 0) || TOKEN_TTL_SEC

  const next = {
    ...account,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + ttlSec * 1000,
    server: account.server === 'client-log' ? 'client-log+refresh' : account.server,
  }
  saveCredentials(next)
  return next
}

/** 是否已到该续期的时候 */
function needsRefresh(account) {
  if (account.refreshToken === '') return false
  if (account.expiresAt === 0) return true
  return Date.now() >= account.expiresAt - REFRESH_LEAD_MS
}

/** 续期进行中时复用同一个 Promise，避免并发打翻 refreshToken */
let inflight = null

/**
 * 取当前可用账号 —— 必要时自动续期。
 *
 * 这是所有调用方的唯一入口。续期失败不会抛给用户（除非连凭据都没有），
 * 而是继续用旧票尝试 —— 旧票可能还有效，总比直接失败强。
 *
 * @param {{ forceRefresh?: boolean, allowRefresh?: boolean }} [options]
 * @returns {Promise<Account>}
 */
export async function getAccount(options = {}) {
  let account = fromEnv() ?? fromCache() ?? fromClientLog()
  if (account === null) {
    throw new Error(
      '找不到 Marvis 登录态。请先打开一次 Marvis 客户端并登录（只要一次，之后不再需要它），' +
        '或设置环境变量 MARVIS_OPENID / MARVIS_ACCESS_TOKEN / MARVIS_GUID / MARVIS_REFRESH_TOKEN。' +
        `（已查找：环境变量、${CACHE}、客户端日志）`,
    )
  }

  // 首次从日志抓到时立刻存起来 —— 这样客户端关掉后还能用
  if (account.server === 'client-log' && account.refreshToken !== '') saveCredentials(account)

  const wants = options.forceRefresh === true || (options.allowRefresh !== false && needsRefresh(account))
  if (!wants || account.refreshToken === '') return account

  if (inflight !== null) return inflight

  inflight = (async () => {
    try {
      return await refreshAccount(account)
    } catch (error) {
      // 续期失败就用旧票 —— 可能还没真过期
      if (error?.signIn === 'expired') {
        const fatal = new Error(`Marvis 登录态已失效（${error.message}）。重新打开客户端登录一次即可。`)
        fatal.signIn = 'expired'
        throw fatal
      }
      return account
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * 同步版本 —— 只读缓存/日志，不触发续期。
 * 给启动日志这类不要等 I/O 的地方用。
 * @returns {Account}
 */
export function getAccountSync() {
  const account = fromEnv() ?? fromCache() ?? fromClientLog()
  if (account === null) {
    throw new Error(
      '找不到 Marvis 登录态。请先打开一次 Marvis 客户端并登录，或设置 MARVIS_OPENID / MARVIS_ACCESS_TOKEN / MARVIS_GUID。',
    )
  }
  if (account.server === 'client-log' && account.refreshToken !== '') saveCredentials(account)
  return account
}

/** 缓存位置，诊断用 */
export const CREDENTIALS_PATH = CACHE
