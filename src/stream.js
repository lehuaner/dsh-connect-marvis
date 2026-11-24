/**
 * SSE 解析 + 上游增量 → harness StreamChunk。
 *
 * 上游是标准 OpenAI 流，但有三个坑：
 *   · `reasoning_content` 与 `content` 会在同一帧里并存，必须分别落到
 *     reasoning / text 块，不能混。
 *   · `tool_calls` 的 `name` 可能只在第一帧出现，`arguments` 分多帧拼接；
 *     而有些网关每帧都重发完整 name —— 两种都要认。
 *   · `finish_reason` 可能是 `tool_calls` / `length` / `stop`，映射错了会让
 *     harness 把工具调用当成普通文本，或者把截断的 JSON 拿去执行。
 */

/**
 * 逐帧吐出 `data:` 后面的 JSON 文本（`[DONE]` 会被跳过）。
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<string>}
 */
export async function* sseLines(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 帧以空行分隔；有些网关只发 \n，所以两种都认
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const payload = framePayload(frame)
        if (payload !== undefined) yield payload
        index = buffer.indexOf('\n\n')
      }
    }
    // 收尾：最后可能没有空行
    const tail = buffer.trim()
    if (tail !== '') {
      const payload = framePayload(tail)
      if (payload !== undefined) yield payload
    }
  } finally {
    reader.releaseLock?.()
  }
}

/**
 * 从一个 SSE 帧里取出 data 负载。
 * @param {string} frame
 * @returns {string | undefined}
 */
function framePayload(frame) {
  let data = ''
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue
    data += line.slice(5).trimStart()
  }
  if (data === '' || data === '[DONE]') return undefined
  return data
}

/**
 * 流式增量累积器 —— 把上游 delta 翻译成 harness 的块事件。
 *
 * 块索引按「首次出现」顺序分配，text / reasoning / tool-call 各占一个。
 */
export class StreamTranslator {
  constructor() {
    /** @type {Map<string, { index: number, kind: string, text: string, id?: string, name?: string, args: string }>} */
    this.open = new Map()
    this.nextIndex = 0
    /** 上一次使用的块（content 与 reasoning 交替时用来判断要不要新开块） */
    this.lastKey = ''
  }

  /**
   * 分配（或复用）一个块槽。
   * @param {string} key 逻辑身份，比如 'text' / 'reasoning' / `tool:0`
   * @param {string} kind
   * @returns {{ index: number, kind: string, text: string, id?: string, name?: string, args: string }}
   */
  slot(key, kind) {
    let block = this.open.get(key)
    if (block === undefined) {
      block = { index: this.nextIndex, kind, text: '', args: '' }
      this.nextIndex += 1
      this.open.set(key, block)
    }
    return block
  }

  /**
   * 处理一个 delta，产出若干 chunk。
   * @param {any} delta
   * @returns {Array<any>}
   */
  push(delta) {
    /** @type {Array<any>} */
    const out = []
    if (delta === null || typeof delta !== 'object') return out

    // ── 推理内容 ──────────────────────────────────────────────
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning !== '') {
      const block = this.slot('reasoning', 'reasoning')
      if (this.lastKey !== 'reasoning') {
        out.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
        this.lastKey = 'reasoning'
      }
      block.text += reasoning
      out.push({ type: 'reasoning-delta', index: block.index, text: reasoning })
    }

    // ── 正文 ─────────────────────────────────────────────────
    const content = delta.content
    if (typeof content === 'string' && content !== '') {
      const block = this.slot('text', 'text')
      if (this.lastKey !== 'text') {
        out.push({ type: 'block-start', index: block.index, blockType: 'text' })
        this.lastKey = 'text'
      }
      block.text += content
      out.push({ type: 'text-delta', index: block.index, text: content })
    }

    // ── 工具调用 ──────────────────────────────────────────────
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const position = Number(call?.index ?? 0)
        const key = `tool:${position}`
        const block = this.slot(key, 'tool-call')
        const id = typeof call?.id === 'string' && call.id !== '' ? call.id : undefined
        if (id !== undefined && block.id === undefined) block.id = id

        const fn = call?.function
        // name 可能只在首帧出现，也可能每帧重发完整值
        if (typeof fn?.name === 'string' && fn.name !== '') {
          const held = block.name ?? ''
          block.name = fn.name.startsWith(held) ? fn.name : held + fn.name
        }

        const argsDelta = typeof fn?.arguments === 'string' ? fn.arguments : ''
        if (block.id !== undefined && !block.started) {
          block.started = true
          out.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
        }
        if (argsDelta !== '') {
          block.args += argsDelta
          out.push({
            type: 'tool-call-delta',
            index: block.index,
            id: block.id ?? '',
            ...(block.name !== undefined && block.name !== '' ? { name: block.name } : {}),
            argumentsDelta: argsDelta,
          })
        } else if (block.started && block.name !== undefined && block.name !== '' && !block.nameSent) {
          // 只给了 name 没给参数 —— 发一条空 delta 把名字带出去
          block.nameSent = true
          out.push({
            type: 'tool-call-delta',
            index: block.index,
            id: block.id ?? '',
            name: block.name,
            argumentsDelta: '',
          })
        }
      }
    }

    return out
  }

  /**
   * 关掉所有打开的块，产出 block-end。
   * @returns {Array<any>}
   */
  closeAll() {
    const out = []
    const blocks = [...this.open.values()].sort((a, b) => a.index - b.index)
    for (const block of blocks) {
      if (block.kind === 'text') {
        if (block.text !== '') out.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning') {
        if (block.text !== '') {
          out.push({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
        }
      } else if (block.kind === 'tool-call') {
        // 参数切断了就是不可执行的调用 —— 让 harness 丢掉它，而不是执行半个 JSON
        const raw = block.args === '' ? '{}' : block.args
        let broken = false
        try {
          JSON.parse(raw)
        } catch {
          broken = true
        }
        if (typeof block.name !== 'string' || block.name === '') broken = true
        if (broken) this.brokenToolCall = true
        out.push({
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: raw,
          },
        })
      }
    }
    this.open.clear()
    return out
  }
}

/**
 * 上游 usage → harness TokenUsage。
 *
 * harness 的计数是**互斥**的：inputTokens 只算未命中的输入，
 * 缓存命中要单独报 cacheReadTokens。上游把两者合在 prompt_tokens 里，
 * 所以必须减掉。
 * @param {any} usage
 * @returns {any | undefined}
 */
export function mapUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

  const prompt = num(usage.prompt_tokens ?? usage.input_tokens)
  const completion = num(usage.completion_tokens ?? usage.output_tokens)
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens) ?? 0
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens)

  if (prompt === undefined && completion === undefined) return undefined

  /** @type {any} */
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (reasoning !== undefined && reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

/**
 * 上游 finish_reason → harness FinishReason。
 * @param {string | null | undefined} reason
 * @param {boolean} sawToolCall
 * @param {boolean} brokenToolCall 参数被截断
 * @returns {any}
 */
export function mapFinish(reason, sawToolCall, brokenToolCall) {
  if (brokenToolCall) return { kind: 'max-tokens' }
  if (reason === 'tool_calls' || sawToolCall) return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}
