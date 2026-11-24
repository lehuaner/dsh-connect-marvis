/**
 * dsh-marvis —— DSH 的 Marvis provider 插件（Host 半身）。
 *
 * 做的事情只有一件：把一个 `marvis` provider 路由注册进 `ctx.llm`，
 * 让它背后的模型（DeepSeek V4.1 Flash / V4 Pro、Claude Sonnet 4.6、
 * GPT-5.4、混元）出现在模型选择器里，并且可以直接对话、调用工具。
 *
 * 凭据不在这里 —— 全部复用本机已登录的 Marvis 客户端，见 src/credentials.js。
 *
 * @module index.js
 */

import { MarvisAdapter, PROVIDER, MODELS } from './src/adapter.js'
import { getAccount, getAccountSync, CREDENTIALS_PATH } from './src/credentials.js'
import { fingerprintStatus } from './src/fingerprint.js'

export const name = 'marvis'

/** 只声明真正离不开的服务。`llm` 缺了插件就没有存在意义。 */
export const inject = ['llm']

/**
 * 插件主体。
 * @param {any} ctx
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const adapter = new MarvisAdapter({
    debug: message => logger.debug?.(message),
    warn: message => logger.warn?.(message),
  })

  // 注册路由。用 ctx.effect 挂生命周期：fiber 释放时自动注销，
  // 热重载也能干净地换一代 adapter。
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'dsh-marvis: provider routes')

  // 模型目录变化时通知 GUI 重新拉取
  try {
    ctx.emit('llm/models-updated', PROVIDER)
  } catch {
    /* 事件发不出去不影响注册 */
  }

  // 启动时探一次凭据（会顺带续期），把结果打到日志 —— 用户排障时第一眼就能看到
  void getAccount()
    .then(account => {
      const left = account.expiresAt > 0 ? Math.round((account.expiresAt - Date.now()) / 60000) : null
      logger.info?.(
        `[marvis] provider 就绪 · 账号 ${maskOpenid(account.openid)} · ${MODELS.length} 个模型 · ` +
          `凭据 ${account.server}${left !== null ? ` · 剩 ${left} 分钟` : ''}`,
      )
    })
    .catch(error => {
      logger.warn?.(`[marvis] ${error?.message ?? error}`)
    })

  /** 诊断快照：指纹状态 + 凭据来源 + 到期时间 */
  const statusOf = () => {
    const fingerprint = fingerprintStatus()
    /** @type {any} */
    let account
    try {
      const found = getAccountSync()
      account = {
        openid: maskOpenid(found.openid),
        guid: found.guid,
        hasRefreshToken: found.refreshToken !== '',
        expiresAt: found.expiresAt,
        server: found.server,
      }
    } catch (error) {
      account = { error: error?.message ?? String(error) }
    }
    return { fingerprint, account, credentialsPath: CREDENTIALS_PATH }
  }

  ctx.effect(() => {
    logger.debug?.(`[marvis] status ${JSON.stringify(statusOf())}`)
    return () => {}
  }, 'dsh-marvis: status probe')
}

/** openid 打日志时脱敏 */
function maskOpenid(openid) {
  const text = String(openid ?? '')
  if (text.length <= 8) return text
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}
