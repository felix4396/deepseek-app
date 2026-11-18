// 测试替身：把 diagnostics 的三条写入口收进内存，方便断言「日志里有心跳 / 失败终态字段」。
const store = () => globalThis.__log

export const record = (kind, level, message, fields = {}) => {
  store().records.push({ kind, level, message, fields })
}

export const recordEvent = (kind, message, fields = {}) => {
  store().events.push({ kind, message, fields })
}

export const recordAction = (kind, action, fields = {}) => {
  store().actions.push({ kind, action, fields })
}

export const errorMeta = (error) => ({
  'error.name': error instanceof Error ? error.name : typeof error,
  'error.msg': error instanceof Error ? error.message : String(error),
})

// 与 src/services/diagnostics/redact.ts 同语义：只保留 path，query / hash / host 全丢。
export const redactUrl = (value) => {
  try {
    return new URL(value, 'http://redacted.local').pathname || '/'
  } catch {
    return (value.split(/[?#]/)[0] ?? value) || '/'
  }
}
