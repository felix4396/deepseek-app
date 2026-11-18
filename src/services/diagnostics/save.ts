import type { SaveFeedbackText } from './export.js'
import { saveTextFile } from '../exportText.js'

/** 反馈日志导出复用通用保存通道（原生 SAF / Web Blob），不再单独维护一套。 */
export const saveFeedbackText: SaveFeedbackText = saveTextFile
