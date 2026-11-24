/**
 * Marvis 上游协议 —— 完全按本机 Marvis 客户端的真实请求重建。
 *
 * 三个反直觉的点，改之前先读：
 *
 *   1. `Marvis-Scene` 必须是 `chat`。用 `agent_chat` 会 403 4100404（风控），
 *      换成 `chat` 立刻 200。`title_rewrite` 等其它 scene 会 400 无效模型 id。
 *
 *   2. `Ual-Access-Login-Type` 必须是 `6`，不是 cookie 里 logintype=WX 映射出的 `2`。
 *      写 2 会 401 4100403「登录态过期/未登录」—— 这条最坑，看起来像 token 失效。
 *
 *   3. `model` 只能填**槽位名**（main-auto / claude-sonnet-4-6 / gpt-5.4 …），
 *      填真实模型 id（deepseek-v4-1-flash-261017）会 400 4130001「无效模型id」。
 *      槽位名同时要写进 busInfo 的 `model=`。
 *
 * `Ual-Access-MarvisExt` 的字段顺序照抄客户端日志：字母序，且**没有**
 * osVersion / taskType / clientPlatform / isIoa，但有 originOpenID。
 * 服务端按原文字符串校验，多一个字段就会 4100404。
 */

import { randomUUID } from 'node:crypto'
import { getUskey, qimei36Of, clientVersion } from './fingerprint.js'

/** 模型网关（OpenAI 兼容） */
export const CHAT_URL = 'https://yybadaccess.3g.qq.com/v1/chat/completions'

/** 客户端 UA —— 必须与 Marvis agent 一致，否则风控 */
export const CLIENT_UA = 'AsyncOpenAI/Python 2.32.0'

/** 本机 Marvis 客户端自报的版本（会被 fingerprint.clientVersion 覆盖） */
const FALLBACK_VERSION = '1.60.3600.59'

/** scene 固定为 chat（见文件头第 1 条） */
const SCENE = 'chat'
const AGENT_TAG = 'main'
const LOGIN_TYPE = '6'

const hex32 = () => randomUUID().replace(/-/g, '')

/**
 * 为一次请求生成完整的 Marvis 上下文 + 请求头。
 *
 * busInfo 与请求头必须共用同一份 conv/resp/nonce —— uskey 是由 busInfo 现算的，
 * 两者对不上会被判定为伪造。
 *
 * @param {{ openid: string, accessToken: string, guid: string }} account
 * @param {{ slot: string }} options
 * @returns {Promise<Record<string, string>>}
 */
export async function marvisHeaders(account, { slot }) {
  const conversationId = `conv_${hex32()}`
  const responseId = `resp_${hex32()}`
  const nonce = randomUUID()

  // 七段式，顺序固定
  const busInfo = [
    `marvisAgentTag=${AGENT_TAG}`,
    `marvisConversationID=${conversationId}`,
    `marvisResponseID=${responseId}`,
    `marvisScene=${SCENE}`,
    `model=${slot}`,
    `nonce=${nonce}`,
    `originOpenID=${account.openid}`,
  ].join('&')

  const uskey = await getUskey(busInfo)
  const version = clientVersion()

  // 字母序，字段集合照抄客户端（见文件头）
  const ext = JSON.stringify({
    clientPlatformVersion: version,
    clientVersion: version,
    guid: account.guid,
    nonce,
    originOpenID: account.openid,
    qimei36: qimei36Of(),
    reqScene: 1,
    uskey,
  })

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': CLIENT_UA,
    // 这几条 X-Stainless-* 是 OpenAI Python SDK 的自报头，客户端带着它们，
    // 缺了不一定失败，但保持一致更安全。
    'X-Stainless-Lang': 'python',
    'X-Stainless-Package-Version': '2.32.0',
    'X-Stainless-OS': 'Windows',
    'X-Stainless-Arch': 'other:amd64',
    'X-Stainless-Runtime': 'CPython',
    'X-Stainless-Runtime-Version': '3.11.9',
    'X-Stainless-Async': 'async:asyncio',
    'X-Stainless-Retry-Count': '0',
    Authorization: 'Bearer placeholder',
    'Ual-Access-Openid': account.openid,
    'Ual-Access-Access-Token': account.accessToken,
    'Ual-Access-Login-Type': LOGIN_TYPE,
    'Ual-Access-Guid': account.guid,
    'Ual-Access-Requestid': responseId,
    'Marvis-AgentTag': AGENT_TAG,
    'Marvis-Conversation-ID': conversationId,
    'Marvis-Response-ID': responseId,
    'Marvis-Scene': SCENE,
    'Marvis-Model-Level': '1',
    'Marvis-Protocol-Version': '1000',
    'X-Device-GUID': account.guid,
    'Ual-Access-MarvisExt': ext,
  }
}

/**
 * 把网关错误体翻译成给人看的话。
 * @param {number} status
 * @param {string} text
 * @returns {{ message: string, code: string, retryable: boolean }}
 */
export function describeFailure(status, text) {
  let code = ''
  let msg = ''
  try {
    const json = JSON.parse(text)
    code = String(json?.code ?? '')
    msg = String(json?.msg ?? '')
  } catch {
    msg = text.slice(0, 300)
  }

  // 上游业务码
  if (code === '4100403') {
    return {
      message: 'Marvis 登录态已失效。请打开 Marvis 客户端重新登录，再回到这里重试。',
      code: 'MARVIS_AUTH_EXPIRED',
      retryable: false,
    }
  }
  // ── 4100404：实测是**配额/频次限制**，不是参数校验，也不是设备指纹 ──
  //
  // 证据（probe/59-threshold.mjs、60-quota-scope.mjs、62-recovery.mjs）：
  //   · 连续请求时，第 5 次起稳定返回 4100404；
  //   · 响应耗时从 ~1200ms 骤降到 ~85ms（网关直接挡回，没进模型）；
  //   · 等待 3 分钟以上不恢复，但隔一段时间后再来又能用上 4 次；
  //   · 换任何 slot 都一样被挡，所以是账号级配额而非单模型限制。
  //
  // 结论：一次连续对话里最多约 4 轮就会撞上。这才是真实 agent 会话
  // （工具调用动辄十几轮）里 403 的真正来源。
  if (code === '4100404') {
    return {
      message:
        'Marvis 账号的请求配额用完了（上游 4100404）。这不是配置错误：' +
        '同一个账号连续用几轮就会被挡，需要等配额恢复再继续。' +
        '眼下可以先用别的模型接着做。',
      code: 'MARVIS_QUOTA_EXCEEDED',
      // 值得重试 —— 配额确实会恢复，只是不是几秒的事
      retryable: true,
    }
  }
  // ── 4100406：system 开头是「标准助手身份句」就被判非法请求 ──
  //
  // 证据（词级/句式 A/B，见 messages.js 的 rewriteLeadingIdentity 注释）：
  //   · system 以 `You are a helpful assistant.` / `You are an AI agent.` 开头 → 403 4100406；
  //   · 同样的句子挪到第二行、挪进 user、换个名词、换成中文 → 全部放行；
  //   · 响应 80~100ms，没进模型，与配额无关（4100404 才是配额）。
  //
  // 出口已经在 toChatMessages 里改写掉了，正常不该再看到这条。真看到说明
  // 有别的路径绕过了 messages.js（比如直接调 chatStream），把线索说清楚。
  if (code === '4100406') {
    return {
      message:
        'Marvis 网关判这条请求「非法」（4100406）：它的规则是 system 消息**开头**不能是' +
        '「You are a/an …」这类标准助手身份句。适配器已会自动改写开头身份句；' +
        '若仍出现，请把这一轮的 system 文本发出来。',
      code: 'MARVIS_IDENTITY_REJECTED',
      retryable: false,
    }
  }
  // 4100400 才是真正的"请求体非法"：body 空 / 非 JSON / 被截断 / 开头带 BOM
  if (code === '4100400') {
    return {
      message: 'Marvis 网关说请求体非法（4100400）。多半是这一轮内容里有 BOM 或被截断，请重试。',
      code: 'MARVIS_ILLEGAL_BODY',
      retryable: true,
    }
  }
  if (code === '4130001') {
    return { message: `Marvis 不认这个模型：${msg}`, code: 'MARVIS_INVALID_MODEL', retryable: false }
  }
  if (status === 429) {
    return { message: 'Marvis 限流，请稍后重试。', code: 'RATE_LIMIT', retryable: true }
  }
  if (status >= 500) {
    return { message: `Marvis 服务端错误（HTTP ${status}）：${msg}`, code: 'SERVER', retryable: true }
  }
  if (status === 403) {
    // 403「非法请求」不是业务码拒绝，是网关层直接挡下来的 —— 通常意味着
    // 请求体里有它不认的字段或形状。把原始体带上，别让人猜。
    return {
      message: `Marvis 拒绝了这个请求（HTTP 403）${msg ? `：${msg}` : ''}${code ? `（code=${code}）` : ''}`,
      code: 'MARVIS_BAD_REQUEST',
      retryable: false,
    }
  }
  return {
    message: `Marvis 请求失败（HTTP ${status}）${msg ? `：${msg}` : ''}`,
    code: 'SERVER',
    retryable: false,
  }
}
