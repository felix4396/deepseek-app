/**
 * 脱敏与文本截断：**纯函数，零依赖**（不 import idb / Capacitor / 业务代码）。
 *
 * 单独成文件的原因：错误页（`src/app/errorReport.ts`）也要用同一套脱敏规则把
 * 错误信息复制给用户，而采集层 collector 带着 IndexedDB / Capacitor 依赖，
 * 不该被一个纯文本工具倒拖进来（也让这套规则可以被零依赖单测直接覆盖）。
 */

const REDACTION_RULES: { pattern: RegExp; replacement: string }[] = [
  // API Key（DeepSeek / OpenAI 风格）
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-***' },
  // Authorization: Bearer xxx
  { pattern: /Bearer\s+\S+/g, replacement: 'Bearer ***' },
  // 对象存储 / 网盘的签名参数
  { pattern: /Signature=[^&]*/g, replacement: 'Signature=***' },
  { pattern: /AccessKeyId=[^&]*/g, replacement: 'AccessKeyId=***' },
  // token 可能出现在 query（?token= / &token=）也可能直接写在日志文本里（access token=xxx）
  { pattern: /\btoken=[^&\s]*/g, replacement: 'token=***' },
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

export const truncate = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, limit) : text

/** 任意值转字符串：错误对象取 message，其余尽量 JSON，最后兜底 String() */
export const safeString = (value: unknown): string => {
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
