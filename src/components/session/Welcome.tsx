import clsx from 'clsx'
import { useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 快速 / 专家模式：纯 UI 演示，状态只存在组件本地，不参与请求参数与任何协议行为 */
type ChatMode = 'fast' | 'expert'

const IconBoltOutline24 = () => (
  <svg
    className={styles.modeIcon}
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M13 2.8L4.7 13.6H10.6L9.4 21.2L17.9 10.4H11.8L13 2.8Z"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IconGemOutline24 = () => (
  <svg
    className={styles.modeIcon}
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M12 3.1L20.2 11.5L12 20.9L3.8 11.5L12 3.1Z"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** 分段切换控件：仅视觉，点击只改本地 useState，不写 localStorage、不进 store */
const ModeSwitch = () => {
  const t = useTranslate()
  const [mode, setMode] = useState<ChatMode>('fast')
  return (
    <div className={styles.modeSwitch} role="group" aria-label={t('modeSwitchLabel')}>
      <button
        type="button"
        data-mode="fast"
        aria-pressed={mode === 'fast'}
        className={clsx(styles.modeOption, mode === 'fast' && styles.modeOptionSelected)}
        onClick={() => setMode('fast')}
      >
        <IconBoltOutline24 />
        <span className={styles.modeLabel}>{t('modeFast')}</span>
      </button>
      <button
        type="button"
        data-mode="expert"
        aria-pressed={mode === 'expert'}
        className={clsx(styles.modeOption, mode === 'expert' && styles.modeOptionSelected)}
        onClick={() => setMode('expert')}
      >
        <IconGemOutline24 />
        <span className={styles.modeLabel}>{t('modeExpert')}</span>
      </button>
    </div>
  )
}

/** 新对话：问候语 + 模式切换 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.hero}>
          <div className={styles.greeting}>{t('welcomeMessageChat250808')}</div>
          <ModeSwitch />
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
