import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  FEEDBACK_BASE_URL,
  LEGACY_BODY_MAX_BYTES,
  LEGACY_FEEDBACK_URL,
  LEGACY_LOG_LINE_MAX,
  LEGACY_LOG_MAX_BYTES,
  LEGACY_LOG_RETRY_BYTES,
  LEGACY_META_MAX,
  REQUEST_TIMEOUT_MS,
} from './config.js'
import {
  refineErrorCode,
  statusToErrorCode,
  toFeedbackErrorCode,
  utf8Bytes,
} from './shared.js'
import type {
  FeedbackCategory,
  FeedbackPayload,
  FeedbackTransport,
  FeedbackTransportResult,
  LogEntry,
} from './types.js'

/**
 * 后端**实际**接口的适配实现（实测契约，与 v1 设计不同）：
 *
 *   POST http://62.106.70.167:60012/feedback
 *   Body: { content, type, contact, version, log }     ← log 必须是【字符串】
 *   200: { ok: true, id: "<uuid>", logSize: 51200 }
 *   400: { ok: false, error: "log must be a string" }
 *   413: { ok: false, error: "payload too large" }
 *
 * 约束（实测）：无鉴权头、CORS 放行、日志只能放进 `log` 纯文本；50KB / 200KB 可发，
 * 1MB 连接被重置 —— 所以客户端把 log 硬控在 150KB（见 LEGACY_LOG_MAX_BYTES），
 * 万一被服务端判超限（413 / 连接重置）自动降级到 50KB 重试一次。
 *
 * 它是 FeedbackTransport 的另一个实现：采集层完全不知道这件事。
 * 等后端按 v1 契约（/api/v1/feedback + logs 数组 + 截图）扩展后，把 index.ts 里默认
 * transport 换回 HttpTransport（./transport.http.js）即可。
 */

/** 分类映射：v1 契约的 feature → 后端认识的 suggestion */
const LEGACY_TYPE: Record<FeedbackCategory, string> = {
  bug: 'bug',
  feature: 'suggestion',
  other: 'other',
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** ISO 带时区时间：2026-11-18T09:01:12.345+08:00 */
export const isoLocalTime = (t: number): string => {
  const date = new Date(t)
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

const truncate = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/** 序列化层再脱一次敏（采集层已经做过，这里防止别的调用方绕过采集直接 submit） */
const REDACTION_RULES: { pattern: RegExp; replacement: string }[] = [
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-***' },
  { pattern: /Bearer\s+\S+/g, replacement: 'Bearer ***' },
  { pattern: /Signature=[^&]*/g, replacement: 'Signature=***' },
  { pattern: /AccessKeyId=[^&]*/g, replacement: 'AccessKeyId=***' },
  { pattern: /[?&]token=[^&]*/g, replacement: 'token=***' },
]

export const redactForLog = (text: string): string =>
  REDACTION_RULES.reduce((out, rule) => out.replace(rule.pattern, rule.replacement), text)

/** 一行一条：`<ISO 时间> [level] kind msg {单行 JSON}`，整行 >500 字符截断 */
export const formatLogLine = (entry: LogEntry): string => {
  const parts = [isoLocalTime(entry.t), `[${entry.level}]`, entry.kind]
  if (entry.msg) {
    parts.push(truncate(entry.msg.replace(/\s+/g, ' '), 200))
  }
  if (entry.meta) {
    try {
      parts.push(truncate(JSON.stringify(entry.meta), LEGACY_META_MAX))
    } catch {
      // meta 不可序列化时省略
    }
  }
  return truncate(redactForLog(parts.join(' ')), LEGACY_LOG_LINE_MAX)
}

/** 环境信息不进 content，改为 log 开头的三行 header */
const headerLines = (payload: FeedbackPayload): string[] => {
  const { app, device, client } = payload
  return [
    `=== app ${app.version}(${app.versionCode}) ${app.buildType} ${app.platform} ===`,
    `=== device ${device.model} / Android ${device.androidVersion} / WebView ${device.webviewVersion} / ${device.screen} / ${device.locale} ===`,
    `=== session ${client.sessionId} client ${client.clientId} ===`,
  ]
}

/** 永不删除的条目：所有 error + 最后一次 import_* / chat_* / state_snapshot */
const protectedEntries = (logs: LogEntry[]): Set<LogEntry> => {
  const keep = new Set<LogEntry>()
  for (const entry of logs) {
    if (entry.level === 'error') {
      keep.add(entry)
    }
  }
  const lastImportChat = [...logs]
    .reverse()
    .find((entry) => entry.kind.startsWith('import_') || entry.kind.startsWith('chat_'))
  if (lastImportChat) {
    keep.add(lastImportChat)
  }
  const lastSnapshot = [...logs].reverse().find((entry) => entry.kind === 'state_snapshot')
  if (lastSnapshot) {
    keep.add(lastSnapshot)
  }
  return keep
}

export type LegacyLogBuild = {
  /** 最终写进 `log` 字段的纯文本（一行一条） */
  log: string
  /** log 的 UTF-8 字节数（原始文本，未 JSON 转义） */
  logBytes: number
  /** 被裁掉的日志条数 */
  omitted: number
  /** 是否发生了裁剪（开头会带 [truncated] 行） */
  truncated: boolean
}

export type LegacyLogOptions = {
  /** 只保留 error + 最后一次 import_* / chat_* / state_snapshot（降级重试用） */
  errorsOnly?: boolean
}

/**
 * 裁剪优先级（数字越小越先丢）：info → net_request → 其余（warn 等）。
 * 采集层不产出 debug 级日志，所以「先丢 debug」这一档在本项目里为空。
 */
const dropPriority = (entry: LogEntry): number => {
  if (entry.kind === 'net_request') {
    return 2
  }
  if (entry.level === 'info') {
    return 1
  }
  return 3
}

/**
 * 生成 `log` 字段：环境 header + 一行一条日志，总体 ≤ limitBytes（原始文本）。
 *
 * 裁剪规则（超限时按顺序丢）：
 * 1. `debug`（当前采集层不产出，保留分支）；
 * 2. 最旧的 `info`；
 * 3. 最旧的 `net_request`（保留 `net_response` / `net_error`）；
 * 4. 其余最旧条目；
 * 5. **永不删** error 级与最后一次 `import_*` / `chat_*` / `state_snapshot`；
 * 裁完在 log 开头插一行 `[truncated] 省略了 N 条较早日志（原始 X KB）`。
 */
export const buildLegacyLog = (
  payload: FeedbackPayload,
  limitBytes = LEGACY_LOG_MAX_BYTES,
  options: LegacyLogOptions = {}
): LegacyLogBuild => {
  const header = headerLines(payload)
  const logs = payload.logs
  const keep = protectedEntries(logs)
  const rawBytes = logs.reduce((sum, entry) => sum + utf8Bytes(entry.msg), 0)

  const lineOf = new Map<LogEntry, string>()
  for (const entry of logs) {
    lineOf.set(entry, formatLogLine(entry))
  }

  const compose = (selected: LogEntry[], omitted: number): string => {
    const mark =
      omitted > 0
        ? [`[truncated] 省略了 ${omitted} 条较早日志（原始 ${Math.max(1, Math.round(rawBytes / 1024))} KB）`]
        : []
    return [...mark, ...header, ...selected.map((entry) => lineOf.get(entry) ?? '')].join('\n')
  }

  const result = (selected: LogEntry[], omitted: number): LegacyLogBuild => {
    const log = compose(selected, omitted)
    return { log, logBytes: utf8Bytes(log), omitted, truncated: omitted > 0 }
  }

  // 降级重试模式：只要 error + 关键事件，其余全部先丢掉
  let selected = options.errorsOnly ? logs.filter((entry) => keep.has(entry)) : logs.slice()
  let omitted = logs.length - selected.length
  if (utf8Bytes(compose(selected, omitted)) <= limitBytes) {
    return result(selected, omitted)
  }

  // 按优先级分档丢（同一档内从最旧开始）
  for (const priority of [0, 1, 2, 3]) {
    const droppable = selected.filter((entry) => !keep.has(entry) && dropPriority(entry) === priority)
    for (const entry of droppable) {
      selected = selected.filter((item) => item !== entry)
      omitted += 1
      if (utf8Bytes(compose(selected, omitted)) <= limitBytes) {
        return result(selected, omitted)
      }
    }
  }

  // 只剩保护条目还超限：从较旧的非 error 保护条目开始丢（error 尽量留到最后）
  for (const entry of selected.filter((item) => item.level !== 'error')) {
    selected = selected.filter((item) => item !== entry)
    omitted += 1
    if (utf8Bytes(compose(selected, omitted)) <= limitBytes) {
      return result(selected, omitted)
    }
  }

  // 极端情况：连 error 也太多，按比例砍
  while (utf8Bytes(compose(selected, omitted)) > limitBytes && selected.length > 1) {
    selected = selected.slice(Math.ceil(selected.length / 4))
    omitted = logs.length - selected.length
  }
  return result(selected, omitted)
}

export type LegacyRequestBody = {
  content: string
  type: string
  contact: string
  version: string
  log: string
}

export type LegacyRequestBuild = {
  body: LegacyRequestBody
  build: LegacyLogBuild
  /** JSON.stringify(body) 的 UTF-8 字节数（判定口径） */
  bodyBytes: number
}

/**
 * 组装 body 并把「序列化后体积」压到 LEGACY_BODY_MAX_BYTES 以内。
 *
 * 判定口径是 `JSON.stringify(body)` 的字节数（转义会膨胀 10–30%），所以按比例迭代收敛，
 * 而不是只看 log 的原始长度。
 */
export const buildLegacyRequest = (
  payload: FeedbackPayload,
  limitBytes = LEGACY_LOG_MAX_BYTES,
  options: LegacyLogOptions = {}
): LegacyRequestBuild => {
  const fields = {
    content: payload.feedback.description.trim(),
    type: LEGACY_TYPE[payload.feedback.category] ?? 'other',
    contact: payload.feedback.contact ?? '',
    version: `${payload.app.version}(${payload.app.versionCode})`,
  }
  let limit = limitBytes
  let build = buildLegacyLog(payload, limit, options)
  let body: LegacyRequestBody = { ...fields, log: build.log }
  let bodyBytes = utf8Bytes(JSON.stringify(body))
  for (let round = 0; round < 8 && bodyBytes >= LEGACY_BODY_MAX_BYTES && limit > 4 * 1024; round += 1) {
    // 按比例收：留 5% 安全边际
    limit = Math.max(4 * 1024, Math.floor(limit * (LEGACY_BODY_MAX_BYTES / bodyBytes) * 0.95))
    build = buildLegacyLog(payload, limit, options)
    body = { ...fields, log: build.log }
    bodyBytes = utf8Bytes(JSON.stringify(body))
  }
  return { body, build, bodyBytes }
}

const readErrorText = (body: unknown): string => {
  if (typeof body === 'string') {
    return body
  }
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string') {
      return error
    }
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message
      if (typeof message === 'string') {
        return message
      }
    }
  }
  return ''
}

const readSuccess = (body: unknown): { id: string; logSize?: number } | null => {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const record = body as { ok?: unknown; id?: unknown; logSize?: unknown }
  if (record.ok !== true || typeof record.id !== 'string' || !record.id) {
    return null
  }
  return {
    id: record.id,
    ...(typeof record.logSize === 'number' ? { logSize: record.logSize } : {}),
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * 服务端实收日志明显小于本地发送量 → 说明被服务端截断了，打一条 warn 便于发现。
 * （oxlint 默认禁 console，这里是有意保留的运维提示，同时会被采集层的 console hook 记进日志）
 */
const warnIfTruncated = (logSize: number | undefined, logBytes: number, bodyBytes: number): void => {
  if (logSize === undefined || logSize === 0) {
    return
  }
  if (logSize < logBytes * 0.9) {
    // eslint-disable-next-line no-console
    console.warn(
      `[diagnostics] 服务端 logSize=${logSize} 明显小于本地发送 ${logBytes}（body ${bodyBytes} 字节），可能被截断`
    )
  }
}

/** 连接被重置 / 断网这类「可能是体积太大打崩了」的失败：值得用更小的 log 再试一次 */
const isSizeishFailure = (error: string): boolean =>
  error === 'too_large' || error === 'network' || error === 'timeout'

export class LegacyTransport implements FeedbackTransport {
  readonly name = 'legacy'

  async send(payload: FeedbackPayload): Promise<FeedbackTransportResult> {
    const primary = buildLegacyRequest(payload, LEGACY_LOG_MAX_BYTES)
    const first = await this.post(primary.body, primary.build.logBytes, primary.bodyBytes)
    if (first.ok || !isSizeishFailure(first.error)) {
      return first
    }
    // 降级重试一次：只保留 error + 关键事件，裁到 50KB（用户的问题描述不受影响）
    const retry = buildLegacyRequest(payload, LEGACY_LOG_RETRY_BYTES, { errorsOnly: true })
    const second = await this.post(retry.body, retry.build.logBytes, retry.bodyBytes)
    return second.ok ? { ...second, retried: true } : second
  }

  private async post(
    body: LegacyRequestBody,
    logBytes: number,
    bodyBytes: number
  ): Promise<FeedbackTransportResult> {
    const json = JSON.stringify(body)
    return Capacitor.isNativePlatform()
      ? this.postNative(json, logBytes, bodyBytes)
      : this.postWeb(json, logBytes, bodyBytes)
  }

  private async postWeb(
    json: string,
    logBytes: number,
    bodyBytes: number
  ): Promise<FeedbackTransportResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(LEGACY_FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        signal: controller.signal,
      })
      const text = await response.text().catch(() => '')
      const parsed = parseJson(text)
      if (response.ok) {
        const success = readSuccess(parsed)
        if (success) {
          warnIfTruncated(success.logSize, logBytes, bodyBytes)
          return { ok: true, id: success.id, logBytes, ...(success.logSize === undefined ? {} : { logSize: success.logSize }) }
        }
        return { ok: false, error: 'server', detail: text.slice(0, 200), logBytes }
      }
      const detail = readErrorText(parsed) || `HTTP ${response.status}`
      return {
        ok: false,
        error: refineErrorCode(statusToErrorCode(response.status), detail),
        detail,
        logBytes,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: controller.signal.aborted ? 'timeout' : refineErrorCode('network', message),
        detail: message,
        logBytes,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async postNative(
    json: string,
    logBytes: number,
    bodyBytes: number
  ): Promise<FeedbackTransportResult> {
    try {
      const response = await CapacitorHttp.post({
        url: LEGACY_FEEDBACK_URL,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.parse(json) as unknown,
        connectTimeout: REQUEST_TIMEOUT_MS,
        readTimeout: REQUEST_TIMEOUT_MS,
      })
      const status = typeof response.status === 'number' ? response.status : 0
      const parsed = typeof response.data === 'string' ? parseJson(response.data) : response.data
      if (status >= 200 && status < 300) {
        const success = readSuccess(parsed)
        if (success) {
          warnIfTruncated(success.logSize, logBytes, bodyBytes)
          return { ok: true, id: success.id, logBytes, ...(success.logSize === undefined ? {} : { logSize: success.logSize }) }
        }
        return { ok: false, error: 'server', logBytes }
      }
      const detail = readErrorText(parsed) || `HTTP ${status}`
      return {
        ok: false,
        error: status === 0 ? 'network' : refineErrorCode(statusToErrorCode(status), detail),
        detail,
        logBytes,
      }
    } catch (error) {
      return {
        ok: false,
        error: 'network',
        detail: error instanceof Error ? error.message : String(error),
        logBytes,
      }
    }
  }
}

/** v1 契约的默认域名（保留导出，便于后端扩展后切回 HttpTransport 时对照） */
export const LEGACY_V1_BASE_HINT = FEEDBACK_BASE_URL

/** 便于 UI 与日志展示：错误码 → 中文提示（与 v1 通道同一套文案） */
export { toFeedbackErrorCode }
