import { saveTextFile } from '../services/exportText.js'

export type SavePlainTextResult = 'saved' | 'cancelled'

/** 保存纯文本：复用通用保存通道（Android SAF 原生桥 / Web Blob 下载），失败时抛错由调用方提示。 */
export const savePlainText = (filename: string, text: string): Promise<SavePlainTextResult> =>
  saveTextFile({ filename, mimeType: 'text/plain', text })
