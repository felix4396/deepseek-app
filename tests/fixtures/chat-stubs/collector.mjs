// 测试替身：diagnostics 依赖 DOM / IndexedDB，单测里只把写入口收进内存。
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

export const captureStateSnapshot = async () => ''

export const flushLogs = async () => {}
