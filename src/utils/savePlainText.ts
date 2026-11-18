import { Capacitor } from '@capacitor/core'
import { saveText } from '../services/exportText.js'

export type SavePlainTextResult = 'saved' | 'cancelled'

/**
 * 保存纯文本：Android 走 ExportText 原生桥（系统 SAF 面板，可取消），Web 走 Blob 下载。
 * 能力缺失或写入失败时抛错，由调用方提示，不做静默降级。
 */
export const savePlainText = async (
  filename: string,
  text: string
): Promise<SavePlainTextResult> => {
  if (Capacitor.isNativePlatform()) {
    return saveText({ filename, mimeType: 'text/plain', text })
  }
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('save-unavailable')
  }
  const anchor = document.createElement('a')
  if (!('download' in anchor)) {
    throw new Error('save-unavailable')
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  anchor.href = url
  anchor.download = filename
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
