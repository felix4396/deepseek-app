import type { EnterKeyMode } from '../../services/settings.js'
/**
 * 回车键行为（issue #108）：桌面端与移动端软键盘共用一套判定，纯函数，好测。
 * - enter-send：回车发送，Shift+回车换行（**默认，等于修复前写死的行为**）
 * - modifier-send：回车换行，Ctrl/Cmd+回车发送（桌面端习惯，Android 用户偏好）
 * - button-only：回车只换行，必须点右侧发送按钮（移动端没有 Shift/Ctrl，以按钮为主路径）
 */
export type EnterKeyAction = 'send' | 'newline'

/** 只取判定需要的字段：真实事件与测试快照都能传进来 */
export type EnterKeyEventLike = {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
  /** 旧 WebKit 在合成期不一定置 isComposing，但会给 229 */
  keyCode?: number
}

/** 输入法合成期：任何档位都不许发送 —— 此时回车是「上屏」，必须交给浏览器默认行为 */
const isComposing = (event: EnterKeyEventLike): boolean =>
  event.isComposing === true || event.keyCode === 229

/**
 * 回车键该干什么：'send' 发送（调用方 preventDefault）、'newline' 交给浏览器插换行、
 * null 表示不是回车，不归这里管。
 */
export const resolveEnterKeyAction = (
  event: EnterKeyEventLike,
  mode: EnterKeyMode
): EnterKeyAction | null => {
  if (event.key !== 'Enter') {
    return null
  }
  if (isComposing(event)) {
    return 'newline'
  }
  const modifier = event.ctrlKey === true || event.metaKey === true
  switch (mode) {
    case 'modifier-send':
      // 带 Shift 一律换行：Ctrl+Shift+Enter 不该悄悄把半句话发出去
      return modifier && event.shiftKey !== true ? 'send' : 'newline'
    case 'button-only':
      return 'newline'
    case 'enter-send':
    default:
      return event.shiftKey === true ? 'newline' : 'send'
  }
}

/**
 * 软键盘回车键文案（textarea 的 enterKeyHint）：必须和裸回车的真实行为一致，
 * 否则键盘上写着「发送」却只换行，用户会以为按钮坏了。
 */
export const enterKeyHintFor = (mode: EnterKeyMode): 'send' | 'enter' =>
  resolveEnterKeyAction({ key: 'Enter' }, mode) === 'send' ? 'send' : 'enter'
