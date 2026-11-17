import { translate, type TranslationMessage } from '../../i18n/index.js'
import { getMessagesBaseUrl, getModelsUrl, normalizeBaseUrl } from '../apiConfig.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/**
 * 地址不再写死：每次请求都从当前生效的模型服务配置（providers.ts）取 baseUrl + apiPath，
 * 构建期的 __API_ORIGIN__ 只作为新建配置的预填值。
 */
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用）；地址取当前配置的 baseUrl 根路径 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(getModelsUrl(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${getMessagesBaseUrl()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${getMessagesBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${getMessagesBaseUrl()}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

/** 连通性测试结果；失败时 reason 区分非法地址、超时、网络（含跨域）、HTTP 错误、非 JSON */
export type ProviderProbeResult = {
  ok: boolean
  /** HTTP 状态码，未收到响应时缺省 */
  status?: number
  /** 解析出的模型 id；空数组表示接口通但没给列表 */
  models: string[]
  reason?: 'invalid' | 'timeout' | 'network' | 'http' | 'json'
  /** 原始错误信息（HTTP 与 JSON 情形） */
  message?: string
}

/** 从各种中转的返回里尽量捞出模型 id：字符串数组或 { id / name / model } */
const pickModelIds = (body: unknown): string[] => {
  const readIds = (list: unknown): string[] => {
    if (!Array.isArray(list)) {
      return []
    }
    const ids: string[] = []
    for (const item of list) {
      if (typeof item === 'string') {
        ids.push(item)
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>
        const id = record.id ?? record.name ?? record.model
        if (typeof id === 'string') {
          ids.push(id)
        }
      }
    }
    return ids
  }
  if (Array.isArray(body)) {
    return readIds(body)
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    for (const key of ['data', 'models', 'model_list', 'result']) {
      const ids = readIds(record[key])
      if (ids.length) {
        return ids
      }
    }
  }
  return []
}

/**
 * 连通性测试：GET {baseUrl}/models 带 Bearer key（路径不带 apiPath）。
 * 超时、断网/跨域、非 2xx、非 JSON 分别给出可读原因，不抛异常。
 */
export const probeProvider = async (
  config: { baseUrl: string; apiKey: string },
  timeoutMs = 15000
): Promise<ProviderProbeResult> => {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) {
    return { ok: false, models: [], reason: 'invalid' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      let message = text || response.statusText
      try {
        const body: unknown = JSON.parse(text)
        if (isErrorBody(body)) {
          message = body.error.message
        }
      } catch {
        // 非 JSON 错误体直接展示原文
      }
      return { ok: false, status: response.status, models: [], reason: 'http', message }
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return {
        ok: false,
        status: response.status,
        models: [],
        reason: 'json',
        message: text.slice(0, 200),
      }
    }
    return { ok: true, status: response.status, models: pickModelIds(body) }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, models: [], reason: 'timeout' }
    }
    return {
      ok: false,
      models: [],
      reason: 'network',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
