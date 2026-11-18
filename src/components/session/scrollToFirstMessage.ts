/**
 * 移动端标题栏「回到首条消息」的滚动工具（Issue #106）。
 *
 * 只驱动会话页消息滚动层的偏移，不碰 MessageList 的跟随逻辑，也不用 scrollIntoView：
 *
 * 1. **不能被流式追加抢回去。** MessageList 用 ResizeObserver 在内容长高时把位置钉在底部
 *    （sticky follow），而 `scrollTo({behavior: 'smooth'})` 的原生平滑动画只要被写一次
 *    `scrollTop` 就会被取消 —— 追加一个 token 就能把整段动画掐掉。所以这里**逐帧自己插值**：
 *    每一帧都把位置重新写回动画轨道，跟随逻辑下一帧才动手，而它动手后位置又立刻被拉回来。
 *    动画本身在离开底部 40px 之后会让 MessageList 的 scroll 监听把跟随关掉（它的判据就是
 *    「位置比上一次小 且 不在贴底区」），此后追加内容也不会再抢位置。
 * 2. **长会话 / 虚拟化也能回到首条。** 首条消息在窗口化后不在 DOM 里，查消息节点没有意义；
 *    这里只把滚动层归一化到偏移 0 —— 虚拟列表在 0 位置自然会渲染第 0 条。
 * 3. **短会话 / 已经贴着首条时什么都不做**，所以连点两下、双击没有可滚内容都不会有副作用。
 */

/** 距顶小于该值视为「已经在首条」 */
const AT_TOP = 2
/** 动画时长随距离增长，但有上下限（长会话不至于滑太久，短距离也不至于闪一下） */
const BASE_DURATION_MS = 180
const DURATION_PER_PX = 0.05
const MIN_DURATION_MS = 220
const MAX_DURATION_MS = 600
const SCROLLABLE_OVERFLOW = /(auto|scroll|overlay)/

/** 双击连发时后一次接管前一次，避免两个动画互相拉扯 */
let animationId = 0

const overflowYOf = (element: Element): string =>
  typeof getComputedStyle === 'function' ? getComputedStyle(element).overflowY : ''

const isMessageScrollHost = (element: Element): element is HTMLElement =>
  SCROLLABLE_OVERFLOW.test(overflowYOf(element)) && element.scrollHeight - element.clientHeight > 0

/**
 * 在 scope 子树里找消息滚动层：声明了 overflow-y 可滚、且真的有溢出，取溢出最多的那一个。
 * 不认 CSS module 的类名（那是有哈希的），只认滚动语义。
 */
export const findMessageScrollHost = (scope: Element | null | undefined): HTMLElement | null => {
  if (!scope) {
    return null
  }
  const queue: Element[] = [scope]
  let best: HTMLElement | null = null
  while (queue.length > 0) {
    const element = queue.shift() as Element
    if (isMessageScrollHost(element) && (!best || element.scrollHeight > best.scrollHeight)) {
      best = element
    }
    for (const child of Array.from(element.children)) {
      queue.push(child)
    }
  }
  return best
}

/** 从标题栏往上找会话页根节点，再在它的子树里找消息滚动层；欢迎页 / 无会话时返回 null */
export const resolveMessageScrollHost = (anchor?: Element | null): HTMLElement | null => {
  for (let scope = anchor?.parentElement ?? null; scope; scope = scope.parentElement) {
    const host = findMessageScrollHost(scope)
    if (host) {
      return host
    }
  }
  return null
}

const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3

const animateToTop = (host: HTMLElement, from: number) => {
  const id = ++animationId
  const raf =
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : null
  if (!raf) {
    // 没有 rAF（极老 WebView / 非浏览器环境）：直接归零，功能不丢
    host.scrollTop = 0
    return
  }
  const duration = Math.min(
    MAX_DURATION_MS,
    Math.max(MIN_DURATION_MS, BASE_DURATION_MS + from * DURATION_PER_PX),
  )
  let startedAt: number | null = null
  const step = (stamp: number) => {
    if (id !== animationId) {
      return
    }
    const now = typeof stamp === 'number' ? stamp : Date.now()
    startedAt ??= now
    const progress = Math.min(1, (now - startedAt) / duration)
    const next = Math.round(from * (1 - easeOutCubic(progress)))
    if (progress >= 1 || next <= AT_TOP) {
      host.scrollTop = 0
      return
    }
    host.scrollTop = next
    raf(step)
  }
  raf(step)
}

/**
 * 回到这条会话的第一条消息。
 * @param anchor 标题栏元素（或任意位于会话页内的元素），用来定位消息滚动层
 * @returns 是否真的发起了滚动（已经在首条 / 短会话 / 找不到滚动层都返回 false）
 */
export const scrollToFirstMessage = (anchor?: Element | null): boolean => {
  const host = resolveMessageScrollHost(anchor)
  if (!host || host.scrollTop <= AT_TOP) {
    return false
  }
  animateToTop(host, host.scrollTop)
  return true
}
