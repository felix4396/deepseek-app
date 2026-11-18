import type { FeedbackCategory } from './diagnostics/types.js'

/**
 * 反馈表单草稿（Issue #31）：点「取消」/ Esc / 点遮罩 / 右上角 × 关掉弹窗后**不丢弃**已填内容，
 * 下次打开自动回填。
 *
 * 三条约束（写给后来者，别顺手改成「顺手持久化」）：
 * 1. **只在内存里**：不写 localStorage / sessionStorage / IndexedDB，也不写诊断日志、不上报——
 *    描述与联系方式是用户正文，本轮只解决「同一次运行内取消后重开不该清空」；
 *    App 重启后草稿自然消失，这也是隐私上最省事的默认值。
 * 2. **截图不保留**：截图是 File/Blob 对象，没有可持久化的路径；只记住「上次选过图」，
 *    重开时提示用户重新选择（见 FeedbackDialog 的 feedbackDraftScreenshotHint）。
 * 3. **空草稿等于没有草稿**：打开又原样关掉不留残留，避免下次误以为「恢复了上次内容」。
 */
export type FeedbackDraft = {
  description: string
  contact: string
  category: FeedbackCategory
  /** 上次带过截图（图片本身不保留，只用于提示重新选择） */
  hadScreenshot: boolean
}

let draft: FeedbackDraft | null = null

const hasContent = (value: FeedbackDraft): boolean =>
  value.description.trim() !== '' || value.contact.trim() !== '' || value.hadScreenshot

/** 读草稿（返回副本，调用方改字段不会污染这里）；没有内容时返回 null */
export const readFeedbackDraft = (): FeedbackDraft | null => (draft ? { ...draft } : null)

/** 写草稿；没内容直接清空，不留空壳 */
export const writeFeedbackDraft = (next: FeedbackDraft): void => {
  draft = hasContent(next) ? { ...next } : null
}

/** 清空草稿（用户主动「清空已填内容」，或提交成功后已送达） */
export const clearFeedbackDraft = (): void => {
  draft = null
}
