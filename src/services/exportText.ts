import { Capacitor, registerPlugin } from '@capacitor/core'

interface ExportTextBridge {
  start(options: {
    name: string
    mimeType: string
  }): Promise<{ id?: string; status?: 'ready' | 'cancelled' }>
  writeChunk(options: { id: string; data: string }): Promise<void>
  finish(options: { id: string }): Promise<{ status: 'saved' | 'cancelled' }>
  abort(options: { id: string }): Promise<void>
}

const nativeExport = registerPlugin<ExportTextBridge>('ExportText')
const CHUNK_BYTES = 48 * 1024

const chunkUtf8 = (text: string): string[] => {
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    if (current && bytes + size > CHUNK_BYTES) {
      chunks.push(current)
      current = ''
      bytes = 0
    }
    current += character
    bytes += size
  }
  if (current) {
    chunks.push(current)
  }
  return chunks
}

export const saveText = async (options: {
  filename: string
  mimeType: string
  text: string
}): Promise<'saved' | 'cancelled'> => {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('NATIVE_EXPORT_UNAVAILABLE')
  }
  let id: string | undefined
  try {
    const started = await nativeExport.start({ name: options.filename, mimeType: options.mimeType })
    if (started.status === 'cancelled' || !started.id) {
      return 'cancelled'
    }
    id = started.id
    for (const data of chunkUtf8(options.text)) {
      await nativeExport.writeChunk({ id, data })
    }
    return (await nativeExport.finish({ id })).status
  } catch (error) {
    if (id) {
      await nativeExport.abort({ id }).catch(() => {})
    }
    if ((error as { code?: string })?.code === 'CANCELLED') {
      return 'cancelled'
    }
    throw error
  }
}

/**
 * 保存纯文本文件：Android 走 ExportText 原生桥（SAF 面板，可取消），Web 走 Blob 下载。
 * 能力缺失或写入失败时抛错，由调用方提示，不做静默降级；反馈日志导出与「保存为 TXT」共用这套出口。
 */
export const saveTextFile = async (file: {
  filename: string
  mimeType: string
  text: string
}): Promise<'saved' | 'cancelled'> => {
  if (Capacitor.isNativePlatform()) {
    return saveText(file)
  }
  if (
    typeof Blob === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof document === 'undefined'
  ) {
    throw new Error('SAVE_UNAVAILABLE')
  }
  const anchor = document.createElement('a')
  if (!('download' in anchor)) {
    throw new Error('SAVE_UNAVAILABLE')
  }
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mimeType};charset=utf-8` }))
  anchor.href = url
  anchor.download = file.filename
  try {
    document.body.appendChild(anchor)
    anchor.click()
    return 'saved'
  } finally {
    anchor.remove()
    // 给浏览器留出消费下载的时间，正文不落到别处。
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
