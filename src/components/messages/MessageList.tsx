import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import { DEFAULT_ESTIMATE, VirtualRows } from './virtualRows.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

/**
 * 消息列表（虚拟化，Issue #45）。
 *
 * 只挂载视口附近的行：行高由 `ResizeObserver` 按行实测（流式增长的回答随时在变），
 * 未实测到的行用估值占位，滚动条长度靠上下占位撑住 —— 所以长会话的 DOM 节点数
 * 与历史总条数无关。窗口计算见 `virtualRows.ts`。
 */
export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  /** 消息 id → 实测高度；会话切换时清空，避免带上一个会话的估值。 */
  const heightsRef = useRef(new Map<string, number>())
  const measureRef = useRef<ResizeObserver | null>(null)
  const observedRowsRef = useRef(new Set<Element>())
  /** 上一次渲染时窗口首行的 id 与偏移，用来在实测高度改变上方占位时把阅读位置钉住。 */
  const anchorOffsetRef = useRef<{ id: string; top: number } | null>(null)
  const sessionIdRef = useRef(session.id)
  // 实测结果存在 ref 里，靠这个版本的计数触发重算占位。
  const [, setMeasureVersion] = useState(0)
  const [metrics, setMetrics] = useState({ top: 0, viewport: 0 })
  const messages = getVisibleMessages(session)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 行实测高度 → 未实测行的估值。用已实测高度的均值，比固定常量更接近真实内容。
  let measuredSum = 0
  let measuredCount = 0
  for (const height of heightsRef.current.values()) {
    measuredSum += height
    measuredCount += 1
  }
  const estimate =
    measuredCount === 0
      ? DEFAULT_ESTIMATE
      : Math.max(DEFAULT_ESTIMATE / 2, Math.round(measuredSum / measuredCount))

  const measured = messages.map((message) => heightsRef.current.get(message.id))

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(() => {
      setMetrics((previous) =>
        previous.viewport === scroll.clientHeight
          ? previous
          : { ...previous, viewport: scroll.clientHeight }
      )
      scrollToBottom()
    })
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 单例行高实测：挂载/卸载行时订阅、退订，高度变化（流式增长、版本切换）时重算占位。
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const target = entry.target as HTMLElement
        const id = target.dataset.rowId
        if (!id || !target.isConnected) {
          continue
        }
        const blockSize = entry.borderBoxSize?.[0]?.blockSize
        const height =
          typeof blockSize === 'number' && blockSize > 0
            ? blockSize
            : target.getBoundingClientRect().height
        if (!(height > 0)) {
          continue
        }
        const previous = heightsRef.current.get(id)
        if (previous === undefined || Math.abs(previous - height) >= 0.5) {
          heightsRef.current.set(id, height)
          changed = true
        }
      }
      if (changed) {
        setMeasureVersion((version) => version + 1)
      }
    })
    measureRef.current = observer
    return () => {
      observer.disconnect()
      measureRef.current = null
      observedRowsRef.current = new Set()
    }
  }, [])

  // 每次提交后同步「当前挂载了哪些行」，让实测覆盖到新进窗口的行，并退订已卸载的行。
  useLayoutEffect(() => {
    const observer = measureRef.current
    const content = contentRef.current
    if (!observer || !content) {
      return
    }
    const next = new Set<Element>()
    for (const row of content.querySelectorAll<HTMLElement>('[data-row-id]')) {
      next.add(row)
      observer.observe(row)
    }
    for (const row of observedRowsRef.current) {
      if (!next.has(row)) {
        observer.unobserve(row)
      }
    }
    observedRowsRef.current = next
  })

  // 会话切换：上一个会话的实测高度不再有意义，清空后重新量。
  useLayoutEffect(() => {
    if (sessionIdRef.current !== session.id) {
      sessionIdRef.current = session.id
      heightsRef.current.clear()
      anchorOffsetRef.current = null
      setMeasureVersion((version) => version + 1)
    }
  }, [session.id])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const sync = () => {
      setMetrics((previous) =>
        previous.top === el.scrollTop && previous.viewport === el.clientHeight
          ? previous
          : { top: el.scrollTop, viewport: el.clientHeight }
      )
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    sync()
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
      sync()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  const renderItem = useCallback(
    (message: Message, index: number) =>
      message.role === 'user' ? (
        <UserMessage
          sessionId={session.id}
          message={message}
          retryUploadId={uploadRetryId}
          isFirst={index === 0}
          isLast={index === lastIndex || index === lastIndex - 1}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
        />
      ) : (
        <AssistantMessage
          sessionId={session.id}
          message={message}
          isLast={index === lastIndex}
          streaming={streaming && index === lastIndex}
          busy={streaming}
          versions={versions.get(message.id) ?? EMPTY_VERSIONS}
          onSelectVersion={selectVersion}
        />
      ),
    [lastIndex, selectVersion, session.id, streaming, uploadRetryId, versions]
  )

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            <VirtualRows
              items={messages}
              measured={measured}
              estimate={estimate}
              scrollTop={metrics.top}
              viewport={metrics.viewport}
              anchorEnd={stickyRef.current}
              getId={(message) => message.id}
              renderItem={renderItem}
            />
          </div>
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
