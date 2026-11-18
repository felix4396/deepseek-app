/**
 * 数组兜底：本地存储被外部改坏（半写入 / 导入中断 / 手工改库）时，
 * `messages[].files` 这类字段可能是 null。`null.length` / `null.map` 会直接抛 TypeError，
 * 在没有错误边界的年代就是整屏白屏（issue #28）。渲染前统一过一遍这里。
 */
export const asArray = <T>(value: readonly T[] | null | undefined): readonly T[] =>
  Array.isArray(value) ? value : []
