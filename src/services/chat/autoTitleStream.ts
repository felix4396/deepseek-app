/**
 * 自动标题的流式增量解析（issue #93）。
 *
 * 标题请求改成流式后，这里只做三件事，不碰请求构造、超时与背压：
 *
 * 1. **取增量**：Anthropic 的 `content_block_delta` / OpenAI 的 `choices[0].delta.content`
 *    累加成标题文本；thinking / reasoning 之类的增量一律不要（标题用不到）
 * 2. **判断够用**：标题第一行成行（出现换行）或累积长度到上限就返回 `enough()`，
 *    调用方据此立刻断开连接——不等整段生成完，省上游 token，也缩短占用并发槽位的窗口
 * 3. **失败与非流式同口径**：流内的错误帧（`rate_limit_error` / `overloaded_error` 等）、
 *    工具调用、异常停止原因都算失败，绝不拿半截内容当标题；限流错误带上 `status: 429`，
 *    让调用方沿用 `isAutoTitleThrottled` 的 throttled 记账
 *
 * 整段 JSON 的解析仍在 autoTitle.ts：网关忽略 `stream: true` 直接回 JSON 时走那条老路。
 */
import type { ServerSentEvent } from '../api/sse.js'

/** 线上协议：决定增量从哪个字段取 */
export type TitleStreamProtocol = 'anthropic' | 'openai'

/** 流内错误：带 `status` 时优先按状态码判断（429 → 限流），与 client.ts 的 ApiError 同语义 */
export type TitleStreamFailure = Error & { status?: number }

export type TitleStreamReader = {
  /** 喂一个 SSE 事件，返回本事件里的文本增量（没有则空串） */
  push: (event: ServerSentEvent) => string
  /** 到目前为止累积的完整文本 */
  text: () => string
  /** 标题够用了：调用方应当立刻断开连接 */
  enough: () => boolean
  /** 已确认的失败（错误帧 / 工具调用 / 异常停止原因）；null 表示还没有 */
  failure: () => unknown | null
  /** 流给出的停止原因是否可接受（与非流式判定同一口径） */
  accepted: () => boolean
}

/** 各协议「正常说完」的停止原因；其它值（max_tokens / tool_use …）一律不算标题 */
const ACCEPTED_STOP: Record<TitleStreamProtocol, ReadonlySet<string>> = {
  anthropic: new Set(['end_turn', 'stop_sequence']),
  openai: new Set(['stop']),
}

/** 限流语义：类型或报文里带 rate limit，就按 429 记账（中转常把它写成 400/403 + 一句话） */
const THROTTLE_TEXT = /rate[\s_-]?limit|too\s+many\s+requests/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 流内错误：message 里保留上游类型，让 isAutoTitleThrottled 的报文特征也能命中 */
const streamFailure = (type: string, message: string): TitleStreamFailure => {
  const error: TitleStreamFailure = new Error(message ? `${type}: ${message}` : type)
  if (THROTTLE_TEXT.test(type) || THROTTLE_TEXT.test(message)) {
    error.status = 429
  }
  return error
}

/** `data:` 解析成对象；`[DONE]`、空行、非 JSON 一律返回 null（忽略而不是当失败） */
const parsePayload = (event: ServerSentEvent): Record<string, unknown> | null => {
  const data = event.data.trim()
  if (!data || data === '[DONE]') {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(data)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** OpenAI 兼容的 `message.content` 可能是字符串或分段数组 */
const contentText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map((part) => {
      const item = isRecord(part) ? part : null
      return item && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
}

/**
 * 造一个增量解析器。
 * `maxChars` 由调用方给（autoTitle.ts 的 AUTO_TITLE_MAX_CHARS）：超过它反正会被清洗截断，
 * 早点断开就是白省的 token。
 */
export const createTitleStreamReader = (
  protocol: TitleStreamProtocol,
  options: { maxChars: number }
): TitleStreamReader => {
  const maxChars = Math.max(1, Math.floor(options.maxChars))
  const acceptedStop = ACCEPTED_STOP[protocol]
  let text = ''
  let failure: unknown = null
  let stopReason: string | null = null
  let toolUse = false

  const append = (chunk: unknown): string => {
    if (typeof chunk !== 'string' || !chunk) {
      return ''
    }
    text += chunk
    return chunk
  }

  const flagFailure = (error: unknown) => {
    failure = failure ?? error
  }

  const readOpenAI = (payload: Record<string, unknown>): string => {
    if (isRecord(payload.error)) {
      const error = payload.error
      const type = typeof error.type === 'string' ? error.type : 'error'
      const failureError = streamFailure(
        type,
        typeof error.message === 'string' ? error.message : ''
      )
      const code = typeof error.code === 'number' ? error.code : error.status
      if (typeof code === 'number') {
        failureError.status = code
      }
      flagFailure(failureError)
      return ''
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    const choice = isRecord(choices[0]) ? choices[0] : null
    if (!choice) {
      return ''
    }
    if (typeof choice.finish_reason === 'string') {
      stopReason = choice.finish_reason
    }
    const delta = isRecord(choice.delta) ? choice.delta : null
    if (!delta) {
      return ''
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      toolUse = true
    }
    return append(contentText(delta.content))
  }

  const readAnthropic = (payload: Record<string, unknown>): string => {
    const type = typeof payload.type === 'string' ? payload.type : ''
    if (type === 'error') {
      const raw = isRecord(payload.error) ? payload.error : null
      const kind = raw && typeof raw.type === 'string' ? raw.type : 'error'
      flagFailure(streamFailure(kind, raw && typeof raw.message === 'string' ? raw.message : ''))
      return ''
    }
    if (type === 'content_block_start') {
      const block = isRecord(payload.content_block) ? payload.content_block : null
      if (block?.type === 'tool_use') {
        toolUse = true
        return ''
      }
      return block?.type === 'text' ? append(block.text) : ''
    }
    if (type === 'content_block_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : null
      if (!delta) {
        return ''
      }
      if (delta.type === 'input_json_delta') {
        // 工具调用的参数片段：标题请求不该出现，出现了说明模型没按要求输出
        toolUse = true
        return ''
      }
      return delta.type === 'text_delta' ? append(delta.text) : ''
    }
    if (type === 'message_delta') {
      const delta = isRecord(payload.delta) ? payload.delta : null
      if (delta && typeof delta.stop_reason === 'string') {
        stopReason = delta.stop_reason
      }
    }
    return ''
  }

  return {
    push: (event) => {
      const payload = parsePayload(event)
      if (!payload) {
        return ''
      }
      // 事件名本身是 error（部分兼容网关不带 type 字段）也要当失败
      if (event.event === 'error' && typeof payload.type !== 'string') {
        flagFailure(streamFailure('error', typeof payload.message === 'string' ? payload.message : ''))
        return ''
      }
      return protocol === 'openai' ? readOpenAI(payload) : readAnthropic(payload)
    },
    text: () => text,
    enough: () => {
      if (text.trim().length >= maxChars) {
        return true
      }
      // 标题只取第一个非空行：这一行已经完整（有换行）就没必要继续生成
      const lineBreak = text.search(/\r?\n/)
      return lineBreak >= 0 && text.slice(0, lineBreak).trim().length > 0
    },
    failure: () => failure,
    accepted: () => !toolUse && !failure && (stopReason === null || acceptedStop.has(stopReason)),
  }
}
