import { deleteAppAsset, loadAppAsset, saveAppAsset } from './db.js'

/** 聊天背景图固定使用的素材 key：全局一份，与会话无关。 */
export const CHAT_BACKGROUND_KEY = 'chat-background'

/** 压缩参数：最长边 ≤1600px、JPEG 0.85，避免 4K 原图常驻内存。 */
const MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void }

/** 解码图片：优先 createImageBitmap，失败时回退 <img>（部分格式/旧内核不支持前者）。 */
const decodeImage = async (file: File): Promise<Decoded> => {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch {
      // 交给 <img> 再试一次
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('image decode failed'))
      element.src = url
    })
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      // <img> 已解码完成，URL 可以立即释放
      release: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/** 用 canvas 压缩：最长边 ≤1600px，统一转 JPEG 0.85；动图只保留首帧。 */
export const compressChatBackground = async (file: File): Promise<Blob> => {
  const decoded = await decodeImage(file)
  try {
    if (!decoded.width || !decoded.height) {
      throw new Error('image has no intrinsic size')
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(decoded.width * scale))
    canvas.height = Math.max(1, Math.round(decoded.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('canvas 2d context unavailable')
    }
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    })
    if (!blob) {
      throw new Error('canvas encode failed')
    }
    return blob
  } finally {
    decoded.release()
  }
}

/** 读取已保存的背景图原件；未设置时返回 null。 */
export const readChatBackground = async (): Promise<Blob | null> =>
  (await loadAppAsset(CHAT_BACKGROUND_KEY))?.blob ?? null

/** 压缩后写入 IndexedDB，返回压缩结果供界面立即生效。 */
export const writeChatBackground = async (file: File): Promise<Blob> => {
  const blob = await compressChatBackground(file)
  await saveAppAsset(CHAT_BACKGROUND_KEY, blob)
  return blob
}

export const clearChatBackground = async (): Promise<void> => {
  await deleteAppAsset(CHAT_BACKGROUND_KEY)
}
