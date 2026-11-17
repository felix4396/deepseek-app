import { translate, type TranslationKey, type TranslationParams } from '../../../i18n/index.js'

/**
 * 导入导出失败的原因，key 对应界面提示文案。
 * params 用于带占位符的文案（如大小上限），展示时与外层提示的 {message} 合并。
 */
export class BackupError extends Error {
  constructor(
    readonly key: TranslationKey,
    readonly params?: TranslationParams
  ) {
    super(translate(key, params))
    this.name = 'BackupError'
  }
}

export const fail = (key: TranslationKey, params?: TranslationParams): never => {
  throw new BackupError(key, params)
}
