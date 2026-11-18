import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { MAX_LOG_ENTRIES, MAX_LOG_MESSAGE_LENGTH } from './config.js'
import {
  FEEDBACK_SCHEMA_VERSION,
  type AppInfo,
  type DeviceInfo,
  type EventKind,
  type LogEntry,
  type LogLevel,
  type LogMeta,
  type LogSnapshot,
} from './types.js'

/**
 * 采集层：只负责「记什么」。
 *
 * 三条硬规则：
 * 1. 不认识上传：本文件**不 import transport**，对外只给 getSnapshot()，谁发、发到哪由门面决定；
 * 2. 脱敏在采集时完成（写入缓冲之前），上传层拿到的东西已经是干净的；
 * 3. 绝不采集 API Key 原文与用户对话正文，只记长度 / 条数这类统计量。
 *
 * 「有效覆盖」的四个防空机制也在这里：
 * - 启动即写 app_launch（缓冲区永不为空）；
 * - 每 30 秒 + 关键动作后写 state_snapshot；
 * - 最近 50 个用户动作留痕（点击 / 导航 / 切前后台）；
 * - 所有 catch / 非 2xx / 超时强制写 error 级日志（带 status、durationMs、错误原文、阶段）。
 *
 * 保留策略是**双限**：最多 500 条 **且** 只保留最近 30 分钟（取交集）。
 */

/** 环形缓冲条数上限 */
const MAX_ENTRIES = MAX_LOG_ENTRIES
/** 单条 msg 截断长度 */
const MAX_MSG_LENGTH = MAX_LOG_MESSAGE_LENGTH
/** meta 里字符串值的截断长度（够定位问题即可） */
const MAX_META_LENGTH = 300
/** 时间维度保留：只留最近 30 分钟 */
export const RETENTION_MS = 30 * 60 * 1000
/** 最近保留的用户动作条数（动作链） */
export const MAX_ACTION_TRAIL = 50
/** 周期快照间隔 */
const SNAPSHOT_INTERVAL_MS = 30_000

const DB_NAME = 'chat-diagnostics'
const DB_VERSION = 1
const STORE = 'logs'
const CLIENT_ID_KEY = 'chat-demo:diagnostics-client-id'

type StoredLog = { seq: number } & LogEntry

interface DiagnosticsDB extends DBSchema {
  logs: { key: number; value: StoredLog }
}

// ---------------------------------------------------------------- 脱敏

const REDACTION_RULES: { pattern: RegExp; replacement: string }[] = [
  // API Key（DeepSeek / OpenAI 风格）
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-***' },
  // Authorization: Bearer xxx
  { pattern: /Bearer\s+\S+/g, replacement: 'Bearer ***' },
  // 对象存储 / 网盘的签名参数
  { pattern: /Signature=[^&]*/g, replacement: 'Signature=***' },
  { pattern: /AccessKeyId=[^&]*/g, replacement: 'AccessKeyId=***' },
  { pattern: /[?&]token=[^&]*/g, replacement: 'token=***' },
]

/** 把一段文本里可能出现的密钥 / 签名统一替换成 *** */
export const redact = (text: string): string =>
  REDACTION_RULES.reduce((out, rule) => out.replace(rule.pattern, rule.replacement), text)

/**
 * URL 脱敏：只保留 path，query / hash / host 全部丢掉（签名参数、token 都在 query 里）。
 * 解析失败时退化成「去 query 后再过一遍脱敏规则」。
 */
export const redactUrl = (value: string): string => {
  try {
    const url = new URL(value, 'http://redacted.local')
    return redact(url.pathname) || '/'
  } catch {
    return redact(value.split(/[?#]/)[0] ?? value) || '/'
  }
}

const truncate = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, limit) : text

const safeString = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Error) {
    return value.message || value.name
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const redactMeta = (meta: LogMeta): LogMeta => {
  const out: LogMeta = {}
  for (const [key, value] of Object.entries(meta)) {
    out[key] = typeof value === 'string' ? truncate(redact(value), MAX_META_LENGTH) : value
  }
  return out
}

/** 错误对象拆成 error.msg / error.name / error.stack / http.status 等扁平字段（业务 catch 里也用它） */
export const errorMeta = (error: unknown): LogMeta => {
  const meta: LogMeta = { 'error.msg': truncate(redact(safeString(error)), MAX_META_LENGTH) }
  if (error instanceof Error) {
    meta['error.name'] = error.name
    if (error.stack) {
      meta['error.stack'] = truncate(redact(error.stack), MAX_MSG_LENGTH)
    }
  }
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') {
    meta['http.status'] = status
  }
  return meta
}

// ---------------------------------------------------------------- 环形缓冲（条数 + 时间双限）

let entries: LogEntry[] = []
/** 与 entries 一一对应的落盘序号（环形缓冲溢出时一起丢，才能同步删库） */
let entrySeqs: number[] = []
/** 下一条日志的序号：单调递增，缓冲溢出后也不回退，用作 IndexedDB 的 key */
let nextSeq = 1

let dbPromise: Promise<IDBPDatabase<DiagnosticsDB>> | null = null
/** 落盘串行链：保证「清空 / 刷新 / 测试 flush」时能等到确实写完了 */
let pendingWrites: Promise<unknown> = Promise.resolve()

const getDB = (): Promise<IDBPDatabase<DiagnosticsDB>> => {
  dbPromise ??= openDB<DiagnosticsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'seq' })
      }
    },
  })
  return dbPromise
}

/** 落盘：失败只在内存里保留（隐私模式 / 存储被禁用时不影响业务） */
const persist = (entry: LogEntry, seq: number): void => {
  pendingWrites = pendingWrites
    .then(async () => {
      const db = await getDB()
      await db.put(STORE, { seq, ...entry })
    })
    .catch(() => {
      // 存储不可用：仅内存生效
    })
}

const dropPersisted = (seqs: number[]): void => {
  if (seqs.length === 0) {
    return
  }
  pendingWrites = pendingWrites
    .then(async () => {
      const db = await getDB()
      const tx = db.transaction(STORE, 'readwrite')
      for (const seq of seqs) {
        void tx.store.delete(seq)
      }
      await tx.done
    })
    .catch(() => {
      // 存储不可用：仅内存生效
    })
}

/** 双限裁剪：先按时间（30 分钟）丢过期，再按条数（500）丢最旧 */
const prune = (now = Date.now()): void => {
  const expiredAt = entries.findIndex((entry) => now - entry.t <= RETENTION_MS)
  const dropByTime = expiredAt < 0 ? entries.length : expiredAt
  const dropByCount = Math.max(0, entries.length - dropByTime - MAX_ENTRIES)
  const drop = dropByTime + dropByCount
  if (drop <= 0) {
    return
  }
  entries.splice(0, drop)
  dropPersisted(entrySeqs.splice(0, drop))
}

const push = (entry: LogEntry): void => {
  const seq = nextSeq
  nextSeq += 1
  entries.push(entry)
  entrySeqs.push(seq)
  persist(entry, seq)
  prune()
}

// ---------------------------------------------------------------- 记录 API

/** 各事件类型的默认级别：异常类一律 error，长任务/警告类 warn，其余 info */
const DEFAULT_LEVEL: Partial<Record<EventKind, LogLevel>> = {
  error: 'error',
  net_error: 'error',
  import_error: 'error',
  warning: 'warn',
  longtask: 'warn',
}

/**
 * 记录一条日志（主入口）：先脱敏再截断，写内存环形缓冲并落盘。
 * 返回写入的那条（validatePayload 自动补快照时会用到）。
 */
export const record = (
  kind: EventKind,
  level: LogLevel,
  msg: string,
  meta?: LogMeta
): LogEntry => {
  const entry: LogEntry = {
    t: Date.now(),
    kind,
    level,
    msg: truncate(redact(typeof msg === 'string' ? msg : safeString(msg)), MAX_MSG_LENGTH),
    ...(meta && Object.keys(meta).length > 0 ? { meta: redactMeta(meta) } : {}),
  }
  push(entry)
  return entry
}

/** 按 kind 自动选级别的记录入口 */
export const recordEvent = (kind: EventKind, msg: string, meta?: LogMeta): LogEntry =>
  record(kind, DEFAULT_LEVEL[kind] ?? 'info', msg, meta)

/** 失败必录：所有 catch / 非 2xx / 超时都走这里，强制 error 级并带上错误原文 */
export const recordError = (msg: string, meta: LogMeta = {}, error?: unknown): LogEntry =>
  record('error', 'error', msg, {
    ...(error === undefined ? {} : errorMeta(error)),
    ...meta,
  })

/** 等待落盘队列清空（测试与「清空后立刻导出」场景用） */
export const flushLogs = (): Promise<void> => pendingWrites.then(() => undefined)

/** 清空本地日志（内存 + IndexedDB） */
export const clearLogs = async (): Promise<void> => {
  entries = []
  entrySeqs = []
  actionTrail = []
  try {
    const db = await getDB()
    await db.clear(STORE)
  } catch {
    // 存储不可用：内存已清空
  }
  await flushLogs()
}

/** 启动时把上次落盘的日志读回缓冲（保留本次启动已写的 app_launch，旧的排在前） */
const restore = async (): Promise<void> => {
  try {
    const db = await getDB()
    const stored = await db.getAll(STORE)
    if (stored.length === 0) {
      return
    }
    const kept = stored
      // 历史启动的 app_launch 丢掉：本次启动已经写过一条，旧的 clientId/sessionId 只会误导排查
      .filter((item) => item.kind !== 'app_launch')
      .map((item) => ({
        t: item.t,
        kind: item.kind,
        level: item.level,
        msg: item.msg,
        ...(item.meta ? { meta: item.meta } : {}),
      }))
    // 恢复的旧日志排在本次启动的日志前面，再按双限裁剪
    entries = [...kept, ...entries]
    entrySeqs = [...stored.map((item) => item.seq), ...entrySeqs]
    nextSeq = Math.max(nextSeq, (stored.at(-1)?.seq ?? 0) + 1)
    prune()
  } catch {
    // 读不出来就当没有历史日志
  }
}

// ---------------------------------------------------------------- 环境信息

const UNKNOWN = 'unknown'

/** 构建期注入的应用版本（rspack DefinePlugin），取不到时读 html meta */
const readAppVersion = (): string => {
  try {
    if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
      return String(__APP_VERSION__)
    }
  } catch {
    // 非打包环境（node 直接 import 源码）
  }
  try {
    return (
      document
        .querySelector('meta[name="application-version"]')
        ?.getAttribute('content') ?? UNKNOWN
    )
  } catch {
    return UNKNOWN
  }
}

/** 构建期注入的 versionCode（来自 android/app/build.gradle） */
const readVersionCode = (): number => {
  try {
    if (typeof __APP_VERSION_CODE__ !== 'undefined') {
      return Number(__APP_VERSION_CODE__) || 0
    }
  } catch {
    // 非打包环境
  }
  return 0
}

const readBuildType = (): string => {
  try {
    return typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__ ? 'internal' : 'standard'
  } catch {
    return 'standard'
  }
}

const readPlatform = (): string => {
  try {
    return Capacitor.getPlatform()
  } catch {
    return typeof navigator === 'undefined' ? UNKNOWN : 'web'
  }
}

/** 从 UA 里尽量解析机型 / Android 版本 / WebView 内核版本，解析不到就写 unknown */
const parseAndroidFromUA = (ua: string) => {
  const androidVersion = /Android\s+([\d.]+)/i.exec(ua)?.[1] ?? UNKNOWN
  // 形如 "Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014; wv)"
  const model =
    /Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i.exec(ua)?.[1]?.trim() ?? UNKNOWN
  // WebView 的 UA 带 "wv" 标记，内核版本即 Chrome/xxx
  const webviewVersion = /\bwv\b/.test(ua) ? (/Chrome\/([\d.]+)/i.exec(ua)?.[1] ?? UNKNOWN) : UNKNOWN
  return { androidVersion, model, webviewVersion }
}

const readDeviceInfo = (): DeviceInfo => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const parsed = parseAndroidFromUA(ua)
  const screen =
    typeof window !== 'undefined' && window.screen
      ? `${window.screen.width}x${window.screen.height}`
      : UNKNOWN
  return {
    model: parsed.model,
    androidVersion: parsed.androidVersion,
    webviewVersion: parsed.webviewVersion,
    screen,
    locale: typeof navigator === 'undefined' ? UNKNOWN : navigator.language || UNKNOWN,
  }
}

const readAppInfo = (): AppInfo => ({
  version: readAppVersion(),
  versionCode: readVersionCode(),
  buildType: readBuildType(),
  platform: readPlatform(),
})

// ---------------------------------------------------------------- clientId / sessionId

const createId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // 降级
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

let clientIdCache: string | null = null
let sessionIdCache: string | null = null

/** 设备级 UUID：持久化在 localStorage，清不掉就只在本次进程内有效 */
const readClientId = (): string => {
  if (clientIdCache) {
    return clientIdCache
  }
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY)
    if (saved) {
      clientIdCache = saved
      return saved
    }
    const created = createId()
    localStorage.setItem(CLIENT_ID_KEY, created)
    clientIdCache = created
    return created
  } catch {
    clientIdCache = createId()
    return clientIdCache
  }
}

/** 会话级 UUID：每次启动新生成（同一个页面里刷新也算新会话） */
const readSessionId = (): string => (sessionIdCache ??= createId())

// ---------------------------------------------------------------- 动作链 / 状态快照

export type SnapshotFacts = {
  sessions: number
  files: number
  provider: string
  model: string
  view: string
  configured: boolean
}

export type FactsProvider = () => SnapshotFacts | Promise<SnapshotFacts>

/** 应用侧注入的「当前状态」读取器（会话数、附件数、provider/model、当前界面） */
let factsProvider: FactsProvider | null = null

export const setSnapshotFactsProvider = (provider: FactsProvider): void => {
  factsProvider = provider
}

const defaultFacts: SnapshotFacts = {
  sessions: 0,
  files: 0,
  provider: UNKNOWN,
  model: UNKNOWN,
  view: UNKNOWN,
  configured: false,
}

const readStorageBytes = async (): Promise<number | undefined> => {
  try {
    const estimate = await navigator.storage.estimate()
    return typeof estimate.usage === 'number' ? estimate.usage : undefined
  } catch {
    return undefined
  }
}

/** 周期性 / 关键动作后的状态快照：会话数、附件数、IndexedDB 占用、provider/model、当前界面 */
export const captureStateSnapshot = async (reason: string): Promise<LogEntry> => {
  let facts: SnapshotFacts = defaultFacts
  try {
    if (factsProvider) {
      facts = await factsProvider()
    }
  } catch {
    // 拿不到就用默认值，快照本身仍然要写
  }
  const storageBytes = await readStorageBytes()
  return record('state_snapshot', 'info', `state: sessions=${facts.sessions} files=${facts.files} ${facts.provider}/${facts.model} view=${facts.view}`, {
    reason,
    sessions: facts.sessions,
    files: facts.files,
    provider: facts.provider,
    model: facts.model,
    view: facts.view,
    configured: facts.configured,
    ...(storageBytes === undefined ? {} : { storageBytes }),
  })
}

export type ActionRecord = { t: number; action: string }

/** 最近 50 个用户动作（点击 / 导航 / 切前后台），出事时用来还原操作序列 */
let actionTrail: ActionRecord[] = []

export const getActionTrail = (): ActionRecord[] => actionTrail.slice()

/**
 * 用户动作：进动作链（最多 50 条）+ 写一条 nav 日志。
 * 只记控件标识（aria-label / role / 标签名），不记用户输入的文本。
 */
export const recordUserAction = (action: string, meta: LogMeta = {}): LogEntry => {
  const entry = record('nav', 'info', `action: ${action}`, meta)
  actionTrail.push({ t: entry.t, action })
  if (actionTrail.length > MAX_ACTION_TRAIL) {
    actionTrail = actionTrail.slice(-MAX_ACTION_TRAIL)
  }
  return entry
}

/** 关键业务动作（发消息 / 切配置 / 导入 / 上传）：动作链 + 指定的 kind */
export const recordAction = (kind: EventKind, action: string, meta: LogMeta = {}): LogEntry => {
  const entry = record(kind, DEFAULT_LEVEL[kind] ?? 'info', `action: ${action}`, {
    action,
    ...meta,
  })
  actionTrail.push({ t: entry.t, action })
  if (actionTrail.length > MAX_ACTION_TRAIL) {
    actionTrail = actionTrail.slice(-MAX_ACTION_TRAIL)
  }
  return entry
}

// ---------------------------------------------------------------- hooks

let hooksInstalled = false
/** CapacitorHttp 内部会走 fetch：用它做重入标记，避免同一次请求被记两遍 */
let inNativeHttp = 0
let requestSeq = 0

const newRequestId = (): string => {
  requestSeq += 1
  return `r${requestSeq}`
}

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { name?: string }).name === 'AbortError' ||
    (error as { name?: string }).name === 'TimeoutError')

const isTimeoutError = (error: unknown): boolean =>
  /timeout|timed out|time out|ERR_TIMED_OUT/i.test(
    error instanceof Error ? `${error.name} ${error.message}` : String(error)
  )

const readBytesOf = async (response: Response): Promise<number> => {
  const length = Number(response.headers.get('Content-Length') ?? '')
  if (Number.isFinite(length) && length >= 0) {
    return length
  }
  try {
    const text = await response.clone().text()
    return new TextEncoder().encode(text).length
  } catch {
    return 0
  }
}

const readBytesOfValue = (value: unknown): number => {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).length
  }
  try {
    return value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return 0
  }
}

const installWindowErrorHook = (): void => {
  window.addEventListener('error', (event) => {
    const error = event.error
    record('error', 'error', `uncaught: ${safeString(error ?? event.message)}`, {
      stage: 'window.onerror',
      ...errorMeta(error ?? new Error(String(event.message || 'resource error'))),
      ...(event.filename ? { 'url.path': redactUrl(event.filename) } : {}),
      ...(event.lineno ? { line: event.lineno } : {}),
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    record('error', 'error', `unhandled rejection: ${safeString(event.reason)}`, {
      stage: 'unhandledrejection',
      ...errorMeta(event.reason),
    })
  })
}

/** 包装 console.error / console.warn：先记录，再原样转发给原实现（不吞日志） */
const installConsoleHook = (): void => {
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        record(level === 'warn' ? 'warning' : 'error', level, args.map((arg) => safeString(arg)).join(' '), {
          stage: 'console',
        })
      } catch {
        // 采集异常不能影响业务日志输出
      }
      original(...args)
    }
  }
}

/**
 * 包装 fetch：**成功与失败都记**（net_request / net_response / net_error）。
 * 「一直加载」往往是「请求发出但没有响应」，只看失败记录永远查不出来，所以成功也要留痕。
 */
const installFetchHook = (): void => {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return
  }
  const original = window.fetch.bind(window)
  // @types/node 的 undici fetch 与 DOM 的 fetch 重载不同，这里按 DOM 的签名接管
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = Date.now()
    const request = typeof input === 'string' || input instanceof URL ? null : input
    const url = request ? request.url : String(input)
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
    const path = redactUrl(url)
    // CapacitorHttp 自己会记一条，避免重复
    const quiet = inNativeHttp > 0
    const requestId = newRequestId()
    if (!quiet) {
      record('net_request', 'info', `request: ${method} ${path}`, {
        method,
        'url.path': path,
        requestId,
        ...(init?.body === undefined
          ? {}
          : { 'req.bodyBytes': readBytesOfValue(typeof init.body === 'string' ? init.body : '') }),
      })
    }
    try {
      const response = await original(input, init)
      if (!quiet) {
        const ok = response.ok
        record(
          'net_response',
          ok ? 'info' : 'error',
          `response: ${method} ${path} → ${response.status}`,
          {
            method,
            'url.path': path,
            requestId,
            'http.status': response.status,
            durationMs: Date.now() - startedAt,
            bytes: await readBytesOf(response),
            ...(ok ? {} : { 'error.msg': `HTTP ${response.status} ${response.statusText}`.trim() }),
          }
        )
      }
      return response
    } catch (error) {
      if (!quiet) {
        const aborted = isAbortError(error)
        const timeout = isTimeoutError(error)
        record(
          'net_error',
          aborted && !timeout ? 'info' : 'error',
          `request error: ${method} ${path} ${aborted ? '(aborted)' : timeout ? '(timeout)' : safeString(error)}`,
          {
            method,
            'url.path': path,
            requestId,
            durationMs: Date.now() - startedAt,
            reason: aborted ? 'aborted' : timeout ? 'timeout' : 'network',
            ...errorMeta(error),
          }
        )
      }
      throw error
    }
  }
  window.fetch = patched as unknown as typeof window.fetch
}

type NativeHttpResponse = { status?: number; data?: unknown }

/** 包装 CapacitorHttp：原生端不走 fetch，同样成功与失败都记 */
const installCapacitorHttpHook = (): void => {
  const target = CapacitorHttp as unknown as Record<string, unknown>
  for (const name of ['get', 'post', 'put', 'patch', 'delete', 'request'] as const) {
    const original = target[name]
    if (typeof original !== 'function') {
      continue
    }
    const call = original as (options: Record<string, unknown>) => Promise<NativeHttpResponse>
    target[name] = async (options: Record<string, unknown>): Promise<NativeHttpResponse> => {
      const startedAt = Date.now()
      const method = String(options?.method ?? name).toUpperCase()
      const path = redactUrl(String(options?.url ?? ''))
      const requestId = newRequestId()
      inNativeHttp += 1
      record('net_request', 'info', `request: ${method} ${path}`, {
        method,
        'url.path': path,
        requestId,
        native: true,
      })
      try {
        const response = await call.call(CapacitorHttp, options)
        const status = typeof response?.status === 'number' ? response.status : 0
        const ok = status >= 200 && status < 300
        record(
          'net_response',
          ok ? 'info' : 'error',
          `response: ${method} ${path} → ${status}`,
          {
            method,
            'url.path': path,
            requestId,
            'http.status': status,
            durationMs: Date.now() - startedAt,
            bytes: readBytesOfValue(response?.data),
            native: true,
            ...(ok ? {} : { 'error.msg': `HTTP ${status}` }),
          }
        )
        return response
      } catch (error) {
        const timeout = isTimeoutError(error)
        record(
          'net_error',
          'error',
          `request error: ${method} ${path} ${timeout ? '(timeout)' : safeString(error)}`,
          {
            method,
            'url.path': path,
            requestId,
            durationMs: Date.now() - startedAt,
            reason: timeout ? 'timeout' : 'network',
            native: true,
            ...errorMeta(error),
          }
        )
        throw error
      } finally {
        inNativeHttp -= 1
      }
    }
  }
}

/**
 * 长任务：排查「点了没反应 / 卡死」的关键证据。
 *
 * 不用 Long Tasks API —— 实测无头 Chromium 与部分 Android WebView 里 PerformanceObserver
 * 收不到 longtask 条目，会静默漏采。改成事件循环看门狗：每 TICK 毫秒对一次表，
 * 实际间隔比预期多出来的部分就是主线程被阻塞的时间（稳定、跨浏览器）。
 */
const LONG_TASK_TICK_MS = 100
const LONG_TASK_THRESHOLD_MS = 150
let watchdogTimer: ReturnType<typeof setInterval> | null = null

const installLongTaskHook = (): void => {
  if (typeof setInterval !== 'function' || watchdogTimer) {
    return
  }
  let expected = Date.now() + LONG_TASK_TICK_MS
  watchdogTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + LONG_TASK_TICK_MS
    if (lag >= LONG_TASK_THRESHOLD_MS) {
      record('longtask', 'warn', `longtask: main thread blocked ${lag}ms`, {
        durationMs: lag,
        threshold: LONG_TASK_THRESHOLD_MS,
      })
    }
  }, LONG_TASK_TICK_MS)
}

/** 切前台 / 切后台 */
const installVisibilityHook = (): void => {
  if (typeof document === 'undefined') {
    return
  }
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden'
    recordAction(hidden ? 'app_pause' : 'app_resume', hidden ? 'app-pause' : 'app-resume', {
      stage: 'visibility',
    })
    if (!hidden) {
      void captureStateSnapshot('resume')
    }
  })
}

/** 点击留痕：只记控件标识，不记输入内容 */
const installClickHook = (): void => {
  if (typeof document === 'undefined') {
    return
  }
  let lastAt = 0
  let lastLabel = ''
  document.addEventListener(
    'click',
    (event) => {
      const element = event.target instanceof Element ? event.target : null
      if (!element) {
        return
      }
      const control = element.closest('[aria-label],button,[role="tab"],[role="option"]')
      if (!control) {
        return
      }
      const label = (
        control.getAttribute('aria-label') ??
        (control.textContent ?? '').trim().slice(0, 40) ??
        control.tagName
      ).slice(0, 60)
      const now = Date.now()
      // 同一控件 300ms 内的连点只记一次
      if (label === lastLabel && now - lastAt < 300) {
        return
      }
      lastAt = now
      lastLabel = label
      recordUserAction(`click:${label}`, {
        stage: 'click',
        target: control.tagName.toLowerCase(),
        role: control.getAttribute('role') ?? 'button',
      })
    },
    true
  )
}

const installHooks = (): void => {
  if (hooksInstalled || typeof window === 'undefined') {
    return
  }
  hooksInstalled = true
  installWindowErrorHook()
  installConsoleHook()
  installFetchHook()
  installCapacitorHttpHook()
  installLongTaskHook()
  installVisibilityHook()
  installClickHook()
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null
let launchRecorded = false

// ---------------------------------------------------------------- 对外 API

export type CollectorOptions = {
  /** 是否安装全局 hook（默认 true；测试里想完全手动喂日志可关掉） */
  installHooks?: boolean
  /** 状态快照的数据来源（由应用侧注入，采集层不认识业务 store） */
  facts?: FactsProvider
}

/**
 * 初始化采集层：
 * 1. 第一件事就写 app_launch（缓冲区永不为空）；
 * 2. 装 hook、生成 sessionId、恢复上次落盘的日志；
 * 3. 起 30 秒一次的周期快照。
 * 重复调用是安全的（不会重复装 hook，也不会换 sessionId）。
 */
export const initCollector = async (options: CollectorOptions = {}): Promise<void> => {
  if (options.facts) {
    factsProvider = options.facts
  }
  const clientId = readClientId()
  const sessionId = readSessionId()
  const app = readAppInfo()
  const device = readDeviceInfo()
  if (!launchRecorded) {
    launchRecorded = true
    // 启动即写：先落 app_launch，后面的 restore / hook 都不影响「缓冲区非空」
    record('app_launch', 'info', `launch ${app.version}(${app.versionCode}) ${app.buildType} on ${app.platform}`, {
      version: app.version,
      versionCode: app.versionCode,
      buildType: app.buildType,
      platform: app.platform,
      model: device.model,
      androidVersion: device.androidVersion,
      webviewVersion: device.webviewVersion,
      screen: device.screen,
      locale: device.locale,
      clientId,
      sessionId,
    })
  }
  if (options.installHooks !== false) {
    installHooks()
  }
  await restore()
  void captureStateSnapshot('launch')
  snapshotTimer ??= setInterval(() => {
    void captureStateSnapshot('interval')
  }, SNAPSHOT_INTERVAL_MS)
}

/** 采集层唯一的出口：当前环境的日志快照（不含用户填写的 feedback 与截图） */
export const getSnapshot = (): LogSnapshot => {
  prune()
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    app: readAppInfo(),
    device: readDeviceInfo(),
    client: { clientId: readClientId(), sessionId: readSessionId() },
    logs: entries.slice(),
  }
}

/** 当前缓冲里的日志条数 */
export const getLogCount = (): number => {
  prune()
  return entries.length
}
