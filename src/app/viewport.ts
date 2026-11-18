import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const query = window.matchMedia('not all and (min-width: 768px)')

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

/** 声明了可滚动的 overflow —— 判断「这里能不能滚」只认 CSS，不认现测出来的溢出量 */
const SCROLLABLE_OVERFLOW = /auto|scroll/

/**
 * 从 target 往上找「声明了可滚」的容器（含 target 自身，不含 body）。
 *
 * 不用 scrollHeight/clientHeight 现测：高度链一退化（--modal-viewport-height 缺失、父弹窗
 * 没算出有界盒子），滚动容器的 scrollHeight 会等于 clientHeight，能滚的容器被误判成「不可滚」，
 * 于是整页锁接管掉每一次 touchmove —— 触摸事件全到、内容一像素不动、零报错（issue #30）。
 */
const findScrollableAncestor = (target: Element) => {
  for (
    let element: Element | null = target;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    if (SCROLLABLE_OVERFLOW.test(style.overflowY) || SCROLLABLE_OVERFLOW.test(style.overflowX)) {
      return element
    }
  }
  return null
}

/**
 * 这条 touchmove 要不要拦。
 *
 * 条件锁 + 默认 fail-open：只有同时满足
 *   1. 单指（多指是双指缩放，交给浏览器）；
 *   2. target 落在锁范围内（默认整页；锁范围外的浮层目标一律放行）；
 *   3. 祖先链上没有任何声明了 auto|scroll 的容器；
 * 才 preventDefault。其余一律放行 —— 静默锁死比漏拦一次糟得多。
 */
export const shouldPreventTouchMove = (
  event: TouchEvent,
  lockRoot: Element | null = document.body
) => {
  if (event.touches.length !== 1) {
    return false
  }
  const target = event.target instanceof Element ? event.target : null
  if (!target || !lockRoot || !lockRoot.contains(target)) {
    return false
  }
  if (findScrollableAncestor(target)) {
    return false
  }
  return true
}

const onTouchMove = (event: TouchEvent) => {
  if (shouldPreventTouchMove(event)) {
    event.preventDefault()
  }
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => document.removeEventListener('touchmove', onTouchMove)
  }, [enabled])
}

/**
 * 把真实可视高度写进浮层。
 *
 * `--modal-viewport-height` 是 .feedbackDialog 高度链的唯一来源（见 Settings.module.css），
 * 缺了它内容区就不溢出 → 不可滚。所以这个变量**无条件下发**，包括双指缩放
 * （visualViewport.scale !== 1）的时候：按真实可视高度写，总比不写安全。
 * top / height 的像素值仍然只在未缩放时跟 —— 缩放中跟着改会让浮层随视觉视口乱跳。
 */
export const syncModalViewport = (overlay: HTMLElement | null, viewport: VisualViewport | null) => {
  if (!overlay) {
    return
  }
  const height = viewport?.height ?? window.innerHeight
  overlay.style.setProperty('--modal-viewport-height', `${height}px`)
  if (viewport && viewport.scale !== 1) {
    return
  }
  overlay.style.top = `${viewport?.offsetTop ?? 0}px`
  overlay.style.height = `${height}px`
}

/** 移动端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。 */
export const useMobileViewport = (enabled: boolean) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    const viewport = window.visualViewport
    const inputSelector = 'textarea, input:not([type="file"])'
    let animationFrame = 0
    const reset = () => {
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && viewport.scale !== 1) {
        return
      }
      // 失焦后直接恢复 CSS 的全高布局，不等 Safari 收键盘后的 resize。
      if (!document.activeElement?.matches(inputSelector)) {
        reset()
        return
      }
      frame.style.setProperty(
        '--app-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`
      )
      frame.style.setProperty('--app-viewport-top', `${viewport?.offsetTop ?? 0}px`)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准 Safari 延迟更新的视口读数。
      update()
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (document.activeElement?.matches(inputSelector)) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [enabled])

  return frameRef
}
