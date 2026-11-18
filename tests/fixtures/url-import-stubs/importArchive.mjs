// 测试替身：记录「归档解析真的被调用了」，用例靠它证明拒绝发生在解析之前。
export const checkArchiveFormat = async (file) => {
  globalThis.__staged.push({ stage: 'check', size: file.size })
}

export const importArchive = async (file, options) => {
  globalThis.__staged.push({ stage: 'import', size: file.size })
  options?.onProgress?.({ sessions: 0, totalSessions: 0, images: 0 })
  return globalThis.__importCount ?? 0
}
