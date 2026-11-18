/**
 * 「我们的渠道」的传输层：原生走 CapacitorHttp，Web 走 fetch。
 *
 * 为什么放在单独文件：api.ts / invite/api.ts 是纯逻辑（Node 单测直接 import），
 * 而 @capacitor/core 只在这里出现，Web 端 fetch 也可以被 Playwright 的 page.route 打桩，
 * CORS 失败只当作「网络不可用」，不影响业务逻辑本身。
 *
 * 两个导出：
 *  - `httpTransport`   业务默认传输：**不跟随重定向**（原生 disableRedirects、
 *                      Web redirect:'manual'）。/buy 要读 302 的 Location。
 *  - `openCheckout`    用系统浏览器打开收银台（ACTION_VIEW，只放行 https）
 *
 * 网页版（浏览器）**刻意不提供购买能力**：浏览器里 fetch(redirect:'manual') 只能拿到
 * opaqueredirect（status 0、读不到 Location），跟随又会因为收银台域的 CORS 被拦
 * （实测 2026-11-18：pay.xiaodouap.cn 不带 Access-Control-Allow-Origin）。
 * 因此网页版只显示「请在 App 内购买」，不猜单号、不重复下单 —— 购买链路是原生专属能力。
 *
 * 原生的兜底：CapacitorHttp 的 disableRedirects 理论上会带回 302 + location 头，
 * 但这一条在真机上还没验证过；读不到 location 时再走 CheckoutBrowser.resolveLocation
 * （原生 HttpURLConnection，instanceFollowRedirects=false）取一次 Location。
 */
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { isOpenableCheckout, type OursHttpRequest, type OursHttpResult } from './api.js'

/** 原生「用系统浏览器打开收银台」插件（ACTION_VIEW，只放行 https） */
type CheckoutBrowserPlugin = {
  open: (options: { url: string }) => Promise<{ opened?: boolean }>
  /** 只取 302 的 Location（不跟随、不下载正文） */
  resolveLocation: (options: { url: string }) => Promise<{ status?: number; location?: string }>
}
const CheckoutBrowser = registerPlugin<CheckoutBrowserPlugin>('CheckoutBrowser')

export const isNativePlatform = (): boolean => Capacitor.isNativePlatform()

const TIMEOUT_HINTS = ['timeout', 'timed out', 'time out']

const reasonOf = (error: unknown): 'timeout' | 'network' => {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  const lower = text.toLowerCase()
  return lower.includes('abort') || TIMEOUT_HINTS.some((hint) => lower.includes(hint))
    ? 'timeout'
    : 'network'
}

/** 3xx 但响应头里没有 location（部分实现会把它丢掉）：问一次原生插件 */
const nativeLocationFallback = async (
  request: OursHttpRequest,
  status: number
): Promise<string> => {
  if (status < 300 || status >= 400 || request.method !== 'GET') {
    return ''
  }
  try {
    const resolved = await CheckoutBrowser.resolveLocation({ url: request.url })
    return (resolved.location ?? '').trim()
  } catch {
    return ''
  }
}

const nativeRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  try {
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      // CapacitorHttp 会把对象序列化成 JSON；字符串原样发出，content-type 由 headers 决定
      data: request.body,
      responseType: 'text',
      connectTimeout: request.timeoutMs,
      readTimeout: request.timeoutMs,
      // 关键：不跟随 302，让 /buy 能把 Location 带回来
      disableRedirects: true,
    })
    const rawHeaders = (response.headers ?? {}) as Record<string, string>
    const headerLocation = (rawHeaders.location ?? rawHeaders.Location ?? '').trim()
    const location =
      headerLocation !== '' ? headerLocation : await nativeLocationFallback(request, response.status)
    const text =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  }
}

const webRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 关键：不跟随重定向。跨域 302 在浏览器里是 opaqueredirect（status 0、没有 header），
      // 这正是「不跟随」的代价 —— 网页版取收银台地址走 httpTransportFollowing
      redirect: 'manual',
      signal: controller.signal,
    })
    const location = response.headers.get('location') ?? ''
    const text = await response.text()
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 默认传输：原生 CapacitorHttp / Web fetch，两者都不跟随重定向 */
export const httpTransport = (request: OursHttpRequest): Promise<OursHttpResult> =>
  isNativePlatform() ? nativeRequest(request) : webRequest(request)

/**
 * 用系统浏览器打开收银台（ACTION_VIEW）。
 * 非 https 的地址一律拒绝：支付页必须是加密连接，明文地址既不安全也可能被劫持。
 */
export const openCheckout = async (url: string): Promise<boolean> => {
  if (!isOpenableCheckout(url)) {
    return false
  }
  if (isNativePlatform()) {
    try {
      await CheckoutBrowser.open({ url })
      return true
    } catch {
      return false
    }
  }
  // 不用 'noopener' 特性串：带它时 window.open 一律返回 null，就分不清「打开了」和「被拦截」了。
  // 改成打开后把 opener 置空（同样断掉 opener 引用，但能判断是否真的打开了）。
  const opened = window.open(url, '_blank')
  if (opened === null) {
    return false
  }
  try {
    opened.opener = null
  } catch {
    // 跨域窗口设不了 opener 也没关系
  }
  return true
}
