import { create } from 'zustand'
import { clearChatBackground, readChatBackground, writeChatBackground } from './appAssets.js'
import { reportStorageError } from './db.js'

type ChatBackgroundState = {
  /** 当前背景图的 object URL；null 表示未设置 */
  url: string | null
  /** 首次读取是否完成，用于区分「还没读」与「确实没有」 */
  ready: boolean
}

/** 聊天背景的全局状态：只有聊天主区域订阅，设置页读取缩略图。 */
export const useChatBackground = create<ChatBackgroundState>(() => ({ url: null, ready: false }))

let objectUrl: string | null = null

const publish = (blob: Blob | null) => {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  if (blob) {
    objectUrl = URL.createObjectURL(blob)
  }
  useChatBackground.setState({ url: objectUrl, ready: true })
}

/** 启动时读一次：IndexedDB 里的图在刷新、重开应用后仍然生效。 */
export const initChatBackground = async (): Promise<void> => {
  try {
    publish(await readChatBackground())
  } catch (error) {
    reportStorageError('load chat background')(error)
    useChatBackground.setState({ ready: true })
  }
}

/** 选图后立即压缩入库并生效。 */
export const applyChatBackground = async (file: File): Promise<void> => {
  publish(await writeChatBackground(file))
}

/** 清除背景：先删库再撤掉界面上的图。 */
export const removeChatBackground = async (): Promise<void> => {
  await clearChatBackground()
  publish(null)
}
