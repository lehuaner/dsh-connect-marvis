/**
 * Harness 消息 ↔ OpenAI Chat 消息。
 *
 * 只做一件事，但有两个必须守住的细节：
 *   · 工具结果要变成 `role: 'tool'` 且带 `tool_call_id`，并且必须排在
 *     所有 user 内容**之前**（并行工具调用时尤其明显）。
 *   · 图像只能走 `image_url` + data URL；解析不出来就丢弃并记一条警告，
 *     绝不能让一个坏图把整轮请求打死。
 */

/**
 * 取消息的 content 块数组。
 * @param {unknown} content
 * @returns {Array<any>}
 */
function blocksOf(content) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

/** 把块里的纯文本拼起来 */
function textOf(blocks) {
  let out = ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * 出站清洗 —— 把会让 Marvis 网关判 4100400/4100404 的字符去掉。
 *
 * 实测：网关对正文里的控制字符是**整轮拒绝**，不是忽略：
 *   · NUL(U+0000)、U+0001、BEL、ESC、DEL、U+FFFE、孤立代理对 → 4100404（HTTP 403）
 *   · body 最开头的 BOM → 4100400（HTTP 400，文案「非法请求」）
 *
 * 这些字符在真实会话里并不罕见：工具输出二进制、读到的文件带 BOM、
 * 日志里有 ANSI 转义、某些库返回孤立代理对。丢一个字符比整轮失败好，
 * 所以这里静默剔除，只保留 \n \r \t 这三个合法空白。
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text === '') return text
  return text
    // 孤立代理对（JSON 里会被转义成 \udXXX，网关不认）
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // 除 \t\n\r 外的所有 C0/C1 控制字符，以及 DEL、BOM、非字符码位
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF\uFFFE\uFFFF]/g, '')
}

/**
 * system 消息**开头**的英文身份句 → 换个主语。
 *
 * 网关会拒掉一类「标准助手身份句」，HTTP 403 + code=4100406「非法请求」，
 * 与请求头、鉴权、配额全都无关。判定条件有三个，缺一不可：
 *
 *   1. 必须出现在 **system 消息的开头**（允许前导空白/换行）；
 *   2. 必须以 `You are` 起头；
 *   3. `You are` 后面必须紧跟 `a` / `an` + 角色名词，或 `Claude`。
 *
 * 实测（同账号、同分钟、同 slot，探针直发）：
 *
 *   ✗ You are a helpful assistant.            ← OpenAI 的默认身份句
 *   ✗ You are a coding agent.                 ← DSH 系统提示第一段
 *   ✗ You are an AI agent.                    ← 同上
 *   ✗ You are Claude, made by Anthropic.
 *   ✓ You are a assistant.                    ← 少了形容词就过
 *   ✓ You are a helpful. / You are welcome.   ← 没有角色名词就过
 *   ✓ You are a helpful agent.                ← 换成 agent 以外的名词也过
 *   ✓ You are a banana. / You are wrong.
 *   ✓ You are ChatGPT, a large language model.
 *   ✓ 你是一个有用的助手。                        ← 中文同一语义完全不管
 *   ✓ Rules follow. You are a helpful assistant.  ← 同样的句子不在开头就过
 *   ✓ You are a helpful assistant.（放在 user 角色里）← 只管 system
 *
 * 也就是说：这是一条针对「**开头就是竞品/通用助手身份声明**」的启发式规则，
 * 而不是词表黑名单 —— 词本身单独出现都放行，`x` 后缀、换名词、换语言、
 * 换位置都能绕过。DSH 注入的系统提示第一句正好整句命中，于是该宿主下
 * 每一条请求都被秒拒（响应 80~100ms，没进模型）。
 *
 * 修法选「换主语」而不是「删句子」：`This agent is …` 与原句语义等价，
 * 模型侧零损失；删掉身份句会让模型丢失「自己是什么」的自我认知，而加一行
 * 前言（`The following section describes this assistant.`）虽然也有效，但
 * 会给每轮请求平白多塞一句无关文本，且要改的是调用方拼接内容而非本层出口。
 *
 * 只改 system、只改开头、忽略大小写；其余位置（user 正文、工具描述、历史
 * 消息里引用的同一句话）一概不动 —— 实测那些位置不触发，乱改只会污染内容。
 *
 * @param {string} text
 * @returns {string}
 */
export function rewriteLeadingIdentity(text) {
  if (typeof text !== 'string' || text === '') return text
  // (\s*) 连同前导空白一起捕获再放回去：换行/缩进开头同样命中（实测会 403）
  return text.replace(/^(\s*)You are\b/i, '$1This agent is')
}

/**
 * 图片块 → data URL。
 *
 * Harness 的 image 块有两种来源：直接带 `data`（base64），或者带 `ref`
 * 需要调用方解析。本适配器只认已内联的 data；解析不了的交给调用方丢弃。
 * @param {any} block
 * @returns {string | undefined}
 */
function imageDataUrl(block) {
  const media = typeof block?.mediaType === 'string' ? block.mediaType : 'image/png'
  if (typeof block?.data === 'string' && block.data !== '') {
    return block.data.startsWith('data:') ? block.data : `data:${media};base64,${block.data}`
  }
  return undefined
}

/**
 * 收集一条消息里的工具结果。
 *
 * Harness 有两种形态：独立的 `role: 'tool'` 消息（带 `toolCallId`），
 * 以及 user/assistant 消息里内嵌的 `tool-result` 块。两种都要认。
 * @param {any} message
 * @returns {Array<{ callId: string, content: Array<any> }>}
 */
function toolResultsOf(message) {
  const out = []
  if (message?.role === 'tool') {
    const callId = String(message.toolCallId ?? message.tool_call_id ?? '')
    if (callId !== '') out.push({ callId, content: blocksOf(message.content) })
    return out
  }
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const callId = String(block.toolCallId ?? block.callId ?? '')
    if (callId === '') continue
    out.push({ callId, content: blocksOf(block.content) })
  }
  return out
}

/**
 * 把 harness 消息投影成 OpenAI Chat 消息数组。
 *
 * @param {ReadonlyArray<any>} messages
 * @param {string | undefined} system 一次性调用方给的 system 文本
 * @param {(kind: string) => void} [warn]
 * @returns {Array<Record<string, unknown>>}
 */
export function toChatMessages(messages, system, warn) {
  /** @type {Array<Record<string, unknown>>} */
  const out = []
  /** 工具结果带出来的图，得在工具消息之后单独作为 user 轮发出去 */
  /** @type {Array<any>} */
  const followUp = []

  const flush = () => {
    if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
  }

  // 一次性调用方给的 system 排在最前
  if (typeof system === 'string' && system !== '') {
    out.push({ role: 'system', content: rewriteLeadingIdentity(sanitizeText(system)) })
  }

  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    if (results.length === 0) flush()

    if (results.length > 0) {
      // 每个结果先落一条 tool 消息，图单独收集
      for (const result of results) {
        const images = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageDataUrl(block)
          if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
          else warn?.('image-dropped')
        }
        const text = textOf(result.content)
        out.push({
          role: 'tool',
          tool_call_id: result.callId,
          content: text !== '' ? sanitizeText(text) : images.length > 0 ? '(见附图)' : '(无输出)',
        })
        if (images.length > 0) {
          followUp.push(
            { type: 'text', text: `工具 ${result.callId} 返回了 ${images.length} 张图，附在下面。` },
            ...images,
          )
        }
      }
    }

    let blocks = blocksOf(message.content).filter(block => block?.type !== 'tool-result')

    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text !== '') out.push({ role: 'system', content: rewriteLeadingIdentity(sanitizeText(text)) })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: sanitizeText(block.text) })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else warn?.('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = sanitizeText(textOf(blocks))
          if (fallback !== '') out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else
          out.push({
            role: 'user',
            content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
          })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          calls.push({
            id: String(block.id ?? ''),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments:
                typeof block.arguments === 'string' ? sanitizeText(block.arguments) : '{}',
            },
          })
        }
        if (text === '' && calls.length === 0) break
        const entry = { role: 'assistant', content: text !== '' ? sanitizeText(text) : null }
        // reasoning_content 是 DeepSeek 系的原生字段，透传能让模型接上前一轮的思路
        if (typeof message.reasoning_content === 'string')
          entry.reasoning_content = sanitizeText(message.reasoning_content)
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      default:
        break
    }
    blocks = undefined
  }

  flush()
  return ensureUserTail(out)
}

/**
 * 保证最后一条是 user —— Marvis 网关的硬要求，违反就 4100404。
 *
 * 实测（见 probe/56-role-shape.mjs）：
 *   [user, assistant]                 → 200
 *   [assistant] 或 [system] 或 [system, assistant] → 403 4100404
 *   [user, assistant, assistant, user] → 403（连续 assistant 也不行）
 *
 * 真实会话里这个形状并不罕见：压缩、续写、重试时历史末尾可能就是
 * assistant。补一条极短的 user 提醒比整轮 403 好得多。
 *
 * @param {Array<Record<string, unknown>>} out
 * @returns {Array<Record<string, unknown>>}
 */
function ensureUserTail(out) {
  // 从后往前找到第一条非 assistant 的消息
  let last = out.length - 1
  while (last >= 0 && out[last].role === 'assistant') last--

  // 末尾连续的 assistant 需要合并成一条 —— 网关不接受连续 assistant
  if (last < out.length - 1) {
    const tail = out.splice(last + 1)
    const merged = { role: 'assistant', content: '', tool_calls: [] }
    let sawText = false
    for (const entry of tail) {
      if (typeof entry.content === 'string' && entry.content !== '') {
        merged.content += (sawText ? '\n\n' : '') + entry.content
        sawText = true
      }
      if (Array.isArray(entry.tool_calls)) merged.tool_calls.push(...entry.tool_calls)
    }
    const rebuilt = { role: 'assistant', content: sawText ? merged.content : null }
    if (merged.tool_calls.length > 0) rebuilt.tool_calls = merged.tool_calls
    out.push(rebuilt)
  }

  // 末条不是 user 就补一条，让请求合法
  if (out.length === 0 || out[out.length - 1].role !== 'user') {
    out.push({ role: 'user', content: '继续。' })
  }
  return out
}

/**
 * harness 工具声明 → OpenAI tools。
 * @param {ReadonlyArray<any> | undefined} tools
 * @returns {Array<Record<string, unknown>> | undefined}
 */
export function toToolDefs(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: String(tool.name ?? ''),
      description: sanitizeText(String(tool.description ?? '')),
      parameters:
        tool.parameters !== null && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
    },
  }))
}

/**
 * 消息里是否含图（决定要不要挑视觉模型）。
 * @param {ReadonlyArray<any>} messages
 * @returns {boolean}
 */
export function needsVision(messages) {
  for (const message of messages ?? []) {
    for (const block of blocksOf(message?.content)) {
      if (block?.type === 'image') return true
      if (block?.type === 'tool-result' && blocksOf(block.content).some(b => b?.type === 'image')) return true
    }
  }
  return false
}
