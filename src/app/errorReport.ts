/**
 * 错误页要复制给用户的那段「诊断信息」：**纯函数，零依赖**（只 import redact.ts 的纯工具），
 * 这样它可以被 unit 测试直接覆盖，也不必把 React / store / IndexedDB 拉进来。
 *
 * 采集口径（与 issue #28 的结论一致）：
 * - 记错误名 + 错误消息 + 栈 + 版本 + 关键 store 状态摘要；
 * - **不记**任何对话正文、附件内容、API Key —— 复制前整段再过一遍脱敏（密钥 / 签名 / 完整 URL）；
 * - 长度有上限，长栈只留前若干行，避免复制出一屏噪音（用户要贴到 Issue 里）。
 */
import { redact, safeString, truncate } from '../services/diagnostics/redact.js'

/** 状态摘要：只允许短标量，避免把会话正文写进报告 */
export type ErrorReportFacts = Record<string, string | number | boolean>

export type ErrorReportInput = {
  error: unknown
  /** 构建期注入的版本号；拿不到写 unknown */
  version: string
  /** 出错环节，例如 ErrorBoundary（渲染期） */
  stage: string
  /** 关键 store 状态摘要（读不到时传 null） */
  facts?: ErrorReportFacts | null
  /** React 组件栈（可选） */
  componentStack?: string | null
  /** 出错时间（ms），默认取当前时刻 */
  at?: number
}

/** 栈最多保留的行数：再多也帮不上定位，还会把复制内容撑长 */
export const MAX_REPORT_STACK_LINES = 20
/** 单行最长字符数 */
export const MAX_REPORT_LINE_CHARS = 240
/** 整份报告最长字符数（超出直接截断并标注） */
export const MAX_REPORT_CHARS = 4000

/** 完整 URL 一律收敛成「协议//host/***」：链接里可能带签名参数 */
const redactUrls = (text: string): string =>
  text.replace(/https?:\/\/[^\s)"']+/gi, (match) => {
    try {
      const url = new URL(match)
      return `${url.protocol}//${url.host}/***`
    } catch {
      return '***'
    }
  })

/** 复制前的最后一道关口：密钥 / 签名 / 完整 URL 全部抹掉 */
export const scrubReportText = (text: string): string => redact(redactUrls(text))

const errorLine = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message || '(no message)'}`
  }
  return safeString(error)
}

/** 栈按行裁剪：保留头 MAX_REPORT_STACK_LINES 行 */
const clipLines = (text: string, limit: number): string[] => {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
  const kept = lines.slice(0, limit).map((line) => truncate(line.trim(), MAX_REPORT_LINE_CHARS))
  if (lines.length > limit) {
    kept.push(`…（已截断，共 ${lines.length} 行）`)
  }
  return kept
}

const factsLine = (facts: ErrorReportFacts | null | undefined): string => {
  if (!facts || Object.keys(facts).length === 0) {
    return '状态: unknown'
  }
  const parts = Object.entries(facts).map(
    ([key, value]) => `${key}=${truncate(String(value), MAX_REPORT_LINE_CHARS)}`
  )
  return `状态: ${parts.join(' ')}`
}

/**
 * 生成「复制诊断信息」的文本。字段顺序固定，便于人工比对与单测断言。
 */
export const buildErrorReport = (input: ErrorReportInput): string => {
  const at = input.at ?? Date.now()
  const when = new Date(at).toISOString()
  const stack = input.error instanceof Error && input.error.stack ? input.error.stack : ''
  const componentStack = (input.componentStack ?? '').trim()
  const lines = [
    'DeepSeek 应用渲染异常',
    `版本: ${input.version || 'unknown'}`,
    `时间: ${when}`,
    `阶段: ${input.stage}`,
    `错误: ${truncate(errorLine(input.error), MAX_REPORT_LINE_CHARS)}`,
    factsLine(input.facts),
  ]
  // 组件栈在前、JS 栈在后：先看「哪个组件挂了」，再看「崩在哪一行」
  if (componentStack !== '') {
    lines.push('组件栈:')
    lines.push(...clipLines(componentStack, MAX_REPORT_STACK_LINES).map((line) => `  ${line}`))
  }
  if (stack !== '') {
    lines.push('堆栈:')
    lines.push(...clipLines(stack, MAX_REPORT_STACK_LINES).map((line) => `  ${line}`))
  }
  const report = scrubReportText(lines.join('\n'))
  return report.length > MAX_REPORT_CHARS
    ? `${truncate(report, MAX_REPORT_CHARS)}\n…（已截断）`
    : report
}

/**
 * 采集层用的 meta：stage / reason / 错误名与消息（**不记正文**）。
 * 与 window.onerror 那条日志同构，便于在诊断日志里按 stage 切片。
 */
export const errorBoundaryMeta = (
  error: unknown,
  componentStack?: string | null
): {
  stage: string
  reason: string
  'error.name': string
  'error.msg': string
  'error.component'?: string
} => {
  const name = error instanceof Error ? error.name : typeof error
  const reason = error instanceof Error ? 'render-throw' : 'render-throw-non-error'
  const meta: {
    stage: string
    reason: string
    'error.name': string
    'error.msg': string
    'error.component'?: string
  } = {
    stage: 'ErrorBoundary',
    reason,
    'error.name': truncate(name, 80),
    'error.msg': truncate(redact(safeString(error)), MAX_REPORT_LINE_CHARS),
  }
  const firstFrame = (componentStack ?? '')
    .split('\n')
    .map((line) => line.trim())
    // React 的 componentStack 形如「    at UserMessage」；兼容旧格式的「in UserMessage」
    .find((line) => line.startsWith('at ') || line.startsWith('in '))
  if (firstFrame) {
    meta['error.component'] = truncate(firstFrame, 120)
  }
  return meta
}
