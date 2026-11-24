/**
 * Marvis LlmAdapter —— 把 DSH 的 GenerateOptions 接到 Marvis 模型网关。
 *
 * ⚠ 必须把 `LlmAdapter` 抽象基类的**全部**方法都实现出来（鸭子类型，不继承基类）：
 * 内核会直接调用 `adapter.imageRequestPricing(...)` 等方法而不做存在性检查，
 * 缺一个就会在 compaction / 计量路径上炸出 "is not a function"
 * （实测：切换模型时 context compaction failed）。
 *
 * 基类方法清单（dsh-llm/src/index.ts L223）：
 *   providerInfo / providerRetryPolicy / imageRequestPricing / imageRequestTarget /
 *   listModels / resolveModel / prepareCall / stream
 */

import { getAccount, refreshAccount } from './credentials.js'
import { marvisHeaders, describeFailure, CHAT_URL } from './protocol.js'
import { qimei36Of, clientVersion } from './fingerprint.js'
import { MODELS, DEFAULT_MODEL, findModel, catalog } from './models.js'
import { toChatMessages, toToolDefs } from './messages.js'
import { sseLines, StreamTranslator, mapUsage, mapFinish } from './stream.js'

/** provider 路由名 —— GUI 里显示的分组 id */
export const PROVIDER = 'marvis'

/**
 * DSH 的 LlmAdapter 是抽象类，但插件不该硬依赖内核包版本，
 * 所以这里按结构实现（duck typing）：只要方法签名对得上就能注册。
 */
export class MarvisAdapter {
  /**
   * @param {{ debug?: (msg: string) => void, warn?: (msg: string) => void }} [logger]
   */
  constructor(logger) {
    this.logger = logger ?? {}
  }

  /** 分组显示名 */
  providerInfo(provider) {
    return { id: provider, name: 'Marvis' }
  }

  /**
   * 重试策略。
   *
   * 风控与登录失效**不能重试** —— 重试只会让风控更严。
   * 只有传输层与 5xx 值得再试一次。
   *
   * ⚠ 配额（MARVIS_QUOTA_EXCEEDED）刻意**不**放进 retryableCodes：
   *   内核的退避是 800ms 起步、最多几秒，而配额实测要约 5 分钟才恢复。
   *   交给内核只会白白重试一次、再报同样的错。adapter 内部自己做长退避。
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 800,
      maxDelayMs: 4000,
      jitterRatio: 0.2,
    })
  }

  /**
   * 请求侧图像计价 —— 声明为「无」，让内核走自己的中性估算。
   * 必须是同步方法（计量器每次测量都会同步调它）。
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * 发给上游的图像目标尺寸/字节 —— 默认保留归一化后的原图，不缩放。
   * 必须同步。
   * @param {string} _provider
   * @param {string} _model
   * @param {{ width?: number, height?: number, bytes?: number }} image
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /**
   * 绑定一次「模型解析 + 流式派发」到同一代 adapter。
   * 我们的模型目录是静态的，直接按基类默认语义实现。
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * GUI 模型选择器读这里 —— 不实现就选不到模型。
   * @param {string} provider
   */
  async listModels(provider) {
    return catalog().map(entry => ({ ...entry, provider }))
  }

  /**
   * 单个模型的完整元数据。
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const entry = findModel(model) ?? findModel(DEFAULT_MODEL)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: Math.min(entry.maxOutput, 32_768),
      ...(entry.reasoning && Array.isArray(entry.efforts)
        ? {
            reasoning: {
              efforts: entry.efforts.map(id => ({ id, name: effortName(id) })),
              defaultEffort: 'high',
            },
          }
        : {}),
    }
  }

  /**
   * 主入口。
   * @param {any} options GenerateOptions
   * @returns {AsyncIterable<any>}
   */
  stream(options) {
    return this.#run(options)
  }

  /**
   * @param {any} options
   * @returns {AsyncGenerator<any>}
   */
  async *#run(options) {
    /** @type {any} */
    let account
    try {
      // getAccount 会在快到期时自动续期，所以客户端关掉之后依然能用
      account = await getAccount()
    } catch (error) {
      yield finishError(error?.message ?? String(error), error?.signIn === 'expired' ? 'MARVIS_AUTH_EXPIRED' : 'MARVIS_NO_ACCOUNT')
      return
    }

    const slot = findModel(options.model) !== undefined ? options.model : DEFAULT_MODEL
    const messages = toChatMessages(options.messages, options.system, kind => {
      this.logger.debug?.(`marvis: ${kind}`)
    })

    /** @type {Record<string, unknown>} */
    const body = {
      model: slot,
      messages,
      stream: true,
    }
    if (typeof options.temperature === 'number') body.temperature = options.temperature
    if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop

    const tools = toToolDefs(options.tools)
    if (tools !== undefined) body.tools = tools

    // 网关对 body 最开头的 BOM 会直接判 4100400「非法请求」，而 messages 里
    // 的正文已经由 sanitizeText 清过了 —— 这道兜底防的是 stringify 之外的意外。
    const payload = JSON.stringify(body).replace(/^\uFEFF/, '')

    // 排障开关：MARVIS_DUMP=1 时把真实请求体落盘，用来复现上游 403
    if (process.env.MARVIS_DUMP === '1') {
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { homedir } = await import('node:os')
        const dir = join(homedir(), '.dsh', 'marvis-dump')
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `req-${Date.now()}.json`)
        writeFileSync(file, payload, 'utf8')
        this.logger.warn?.(`marvis: 请求体已落盘 ${file}（${payload.length} 字节）`)
      } catch (error) {
        this.logger.warn?.(`marvis: 落盘失败 ${error?.message ?? error}`)
      }
    }

    /**
     * 把失败现场无条件落盘 —— 不靠环境变量，装了就一定留证据。
     * 只保留最近 20 份，避免目录无限长大。
     * @param {string} tag
     * @param {Record<string, unknown>} info
     */
    const dump = async (tag, info) => {
      try {
        const { writeFileSync, mkdirSync, readdirSync, unlinkSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { homedir } = await import('node:os')
        const dir = join(homedir(), '.dsh', 'marvis-dump')
        mkdirSync(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        writeFileSync(join(dir, `${tag}-${stamp}.json`), JSON.stringify(info, null, 2), 'utf8')
        // 只留最近 20 份
        const kept = readdirSync(dir).filter(n => n.endsWith('.json')).sort()
        for (const name of kept.slice(0, Math.max(0, kept.length - 20))) {
          try { unlinkSync(join(dir, name)) } catch { /* 忽略 */ }
        }
      } catch { /* 排障落盘不能影响主流程 */ }
    }

    /**
     * 发一次请求。返回 Response，或者抛错。
     * @param {any} acct
     * @returns {Promise<Response>}
     */
    const send = async acct => {
      const headers = await marvisHeaders(acct, { slot })
      return fetch(CHAT_URL, { method: 'POST', headers, body: payload, signal: options.signal })
    }

    /**
     * 判断一个非 200 响应是不是"配额用完"（4100404）。
     *
     * 上游把配额和参数错误都塞进 4100404，但两者耗时特征完全不同：
     * 真配额是 ~85ms 秒回，参数错误要过一遍校验。这里只看业务码，
     * 因为两者对调用方的含义一致 —— 等一会儿再来。
     * @param {Response} res
     * @returns {Promise<boolean>}
     */
    const isQuota = async res => {
      if (res.ok) return false
      const text = await res.clone().text().catch(() => '')
      return text.includes('4100404')
    }

    /**
     * 等一会儿再发 —— 配额恢复不是几秒的事。
     *
     * 实测（probe/63-waf.mjs）：静默等待 300 秒后恢复，随后连发约 4 次
     * 又会被挡。所以退避序列按 60s → 120s → 180s 递增，合计最多 6 分钟。
     * 期间只要 signal 被取消就立刻停手，不让用户看着卡住的界面。
     * @param {number} attempt
     * @returns {Promise<boolean>} 是否还该继续重试
     */
    const backoff = async attempt => {
      const waits = [60_000, 120_000, 180_000]
      if (attempt >= waits.length) return false
      const ms = waits[attempt]
      this.logger.warn?.(`marvis: 配额用完，等 ${Math.round(ms / 1000)} 秒后重试（第 ${attempt + 1}/${waits.length} 轮）`)
      const signal = options.signal
      if (signal?.aborted === true) return false
      await new Promise(resolve => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      return signal?.aborted !== true
    }

    /** @type {Response} */
    let response
    try {
      response = await send(account)

      // 401 / 4100403 = 票过期。续期一次再重试 —— 这是脱离客户端的关键路径：
      // 客户端关掉后 token 2 小时就死，但我们有 refreshToken 可以自己续。
      if (response.status === 401 && account.refreshToken !== '') {
        const text = await response.clone().text().catch(() => '')
        if (text.includes('4100403') || response.status === 401) {
          this.logger.debug?.('marvis: 票过期，尝试续期后重试')
          try {
            account = await refreshAccount(account)
            response = await send(account)
          } catch (error) {
            this.logger.warn?.(`marvis: 续期失败 ${error?.message ?? error}`)
          }
        }
      }

      // 4100404 配额：一个账号连续约 4 轮就会撞上，而真实 agent 会话
      // 动辄十几轮工具调用 —— 不退避的话每次都在第 5 轮断掉。
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await isQuota(response))) break
        if (!(await backoff(attempt))) break
        response = await send(account)
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      yield finishError(`连不上 Marvis 网关：${error?.message ?? error}`, 'TRANSPORT')
      return
    }

    // ── 非 200：把上游业务码翻译成人话 ──────────────────────
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const failure = describeFailure(response.status, text)

      // 403 这类没有业务码的拒绝，光看「非法请求」猜不出原因。
      // 直接把这一轮的请求体、请求头、响应头全落盘，省得靠反复试。
      await dump(`fail-${response.status}`, {
        at: new Date().toISOString(),
        status: response.status,
        requestUrl: CHAT_URL,
        model: slot,
        requestBytes: payload.length,
        requestHeaders: Object.fromEntries(await (async () => {
          const h = await marvisHeaders(account, { slot })
          return Object.entries(h)
        })()),
        requestBody: body,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseText: text,
        fingerprint: {
          // 出票是否真的成功，是 403 的头号嫌疑
          qimei36: qimei36Of(),
          clientVersion: clientVersion(),
        },
      })

      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: failure.message, code: failure.code, status: response.status },
        },
      }
      return
    }

    // ── 正常流 ──────────────────────────────────────────────
    const translator = new StreamTranslator()
    let sawToolCall = false
    /** @type {any} */
    let usage
    /** @type {string | null} */
    let finishReason = null
    /** @type {string} */
    let servedModel = ''

    try {
      if (response.body === null) {
        yield finishError('Marvis 返回了空响应体', 'EMPTY_RESPONSE')
        return
      }

      for await (const payload of sseLines(response.body)) {
        /** @type {any} */
        let frame
        try {
          frame = JSON.parse(payload)
        } catch {
          // 上游偶尔会夹非 JSON 的心跳帧，跳过即可
          continue
        }

        // 上游在流里报错时是 {code, msg} 而不是 choices
        if (frame?.code !== undefined && frame?.choices === undefined) {
          const failure = describeFailure(200, JSON.stringify(frame))
          yield finishError(failure.message, failure.code)
          return
        }

        if (typeof frame?.model === 'string' && frame.model !== '') servedModel = frame.model
        if (frame?.usage !== undefined) usage = mapUsage(frame.usage)

        const choice = Array.isArray(frame?.choices) ? frame.choices[0] : undefined
        if (choice === undefined) continue

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = String(choice.finish_reason)
        }

        const delta = choice.delta
        if (delta === undefined) continue
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) sawToolCall = true

        for (const chunk of translator.push(delta)) yield chunk
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        for (const chunk of translator.closeAll()) yield chunk
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      yield finishError(`Marvis 流中断：${error?.message ?? error}`, 'TRANSPORT')
      return
    }

    for (const chunk of translator.closeAll()) yield chunk

    if (usage !== undefined) yield { type: 'usage', usage }

    const broken = translator.brokenToolCall === true
    const reason = mapFinish(finishReason, sawToolCall, broken)

    // 一个字都没出 —— 当成错误，让 harness 有机会重试或提示
    if (reason.kind === 'stop' && translator.nextIndex === 0) {
      yield finishError('Marvis 返回了空回复', 'EMPTY_RESPONSE')
      return
    }

    yield {
      type: 'finish',
      reason,
      ...(servedModel !== '' ? { replayState: { response: { model: servedModel } } } : {}),
    }
  }
}

/** 一条终态错误 chunk */
function finishError(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/** 推理档位的中文名 */
function effortName(id) {
  if (id === 'low') return '快速'
  if (id === 'max') return '最深'
  return '标准'
}

/** 暴露给设置面板的模型清单 */
export { MODELS }
