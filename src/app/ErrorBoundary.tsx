import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { useTranslate } from '../i18n/index.js'
import { Button } from '../components/base/Button.js'
import { recordError } from '../services/diagnostics/collector.js'
import { useChatStore } from '../services/chat/store.js'
import { useSettings } from '../services/settings.js'
import { copyText } from '../utils/clipboard.js'
import { readDiagnosticsFacts } from './diagnosticsContext.js'
import { buildErrorReport, errorBoundaryMeta, type ErrorReportFacts } from './errorReport.js'
import styles from './ErrorBoundary.module.css'

/**
 * 全局错误边界（issue #28）。
 *
 * 背景：应用原先没有 ErrorBoundary / getDerivedStateFromError / onUncaughtError，
 * 任何**渲染期**异常（实测：某条会话的 `messages[].files` 被写成 null）都会让 React 卸载整棵树，
 * 结果是 `#root` 子节点 0、整屏纯白、界面零提示 —— 用户完全说不清白屏发生在哪一步。
 *
 * 这里只做两件事：
 * 1. 兜住渲染异常，画一张可读的错误页（一句人话 + 重载 + 复制诊断信息）；
 * 2. 用现有诊断采集层记一条 error（stage/reason + 错误名/消息/栈），**不记对话正文**。
 *
 * 注意：error boundary 只接渲染期异常；事件回调 / 定时器里的异常仍由 window.onerror 采集。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorState> {
  override state: ErrorState = { error: null, componentStack: null }

  static getDerivedStateFromError(error: unknown): Partial<ErrorState> {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null
    // 组件栈要显示在错误页的复制内容里，所以留在 state 上（setState 在 componentDidCatch 里合法）
    this.setState({ componentStack })
    // 采集层已有脱敏 & 截断（errorMeta），这里只补 stage / reason，不写任何聊天正文
    recordError('render error', errorBoundaryMeta(error, componentStack), error)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <ErrorScreen error={this.state.error} componentStack={this.state.componentStack} />
    }
    return this.props.children
  }
}

type ErrorState = { error: unknown; componentStack: string | null }

const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'unknown' : __APP_VERSION__

/** 关键 store 状态摘要：只取短标量（数量、开关、当前视图），绝不碰对话正文 */
const readFacts = (): ErrorReportFacts | null => {
  try {
    const chat = useChatStore.getState()
    const settings = useSettings.getState()
    const base = readDiagnosticsFacts()
    return {
      ready: chat.ready ? 'yes' : 'no',
      sessions: base.sessions,
      loaded: Object.keys(chat.sessionCache).length,
      streaming: Object.keys(chat.streaming).length,
      files: base.files,
      view: base.view,
      provider: base.provider,
      model: base.model,
      configured: base.configured ? 'yes' : 'no',
      locale: settings.locale,
      theme: settings.themePreference,
    }
  } catch {
    // 状态本身也可能已经坏了：拿不到摘要就不写，别让错误页再崩一次
    return null
  }
}

/** 错误页：一句人话 + 两个动作（重载应用 / 复制诊断信息） */
const ErrorScreen = ({
  error,
  componentStack,
}: {
  error: unknown
  componentStack: string | null
}) => {
  const t = useTranslate()
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle')
  // 展示用的原始报错：只取第一行，长消息由 CSS 折行 + 最大高度滚动兜住
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  const onCopy = async () => {
    const report = buildErrorReport({
      error,
      componentStack,
      version: APP_VERSION,
      stage: 'ErrorBoundary',
      facts: readFacts(),
    })
    const ok = await copyText(report)
    setCopyState(ok ? 'done' : 'failed')
  }

  return (
    <div className={styles.screen} role="alert" data-testid="error-boundary">
      <div className={styles.card}>
        <div className={styles.title}>{t('errorScreenTitle')}</div>
        <div className={styles.description}>{t('errorScreenDescription')}</div>
        <code className={styles.detail} data-testid="error-boundary-detail">
          {detail}
        </code>
        <div className={styles.actions}>
          <Button
            size="m"
            data-testid="error-boundary-reload"
            onClick={() => window.location.reload()}
          >
            {t('errorScreenReload')}
          </Button>
          <Button
            variant="outlined"
            size="m"
            data-testid="error-boundary-copy"
            onClick={() => void onCopy()}
          >
            {t(
              copyState === 'done'
                ? 'errorScreenCopied'
                : copyState === 'failed'
                  ? 'errorScreenCopyFailed'
                  : 'errorScreenCopyDiagnostics'
            )}
          </Button>
        </div>
        <div className={styles.hint}>{t('errorScreenHint')}</div>
      </div>
    </div>
  )
}
