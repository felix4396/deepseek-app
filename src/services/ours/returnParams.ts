/**
 * 网页版付款回跳（Issue #36）。
 *
 * 支付在收银台（支付宝）完成，回跳时地址栏应该是：
 *   https://<我们的网页>/?no=<out_trade_no>&order_token=<token>
 *
 * 这里只做两件纯事：
 *  1. 从 `location.search` 里认出这两个参数（解析在 api.ts 的 parseOrderReturn，单测覆盖）；
 *  2. 认出来之后立刻把参数从地址栏清掉（order_token 等同凭据，不该留在历史记录里；
 *     刷新也不会再触发一次查单），并把单号 / 令牌交给 orderStore 落盘，
 *     供「订单」区块挂载时续查。
 *
 * 应用启动处（main.tsx）调用一次 consumeOrderReturn()：有回跳就直接打开
 * 「我们的渠道」设置层，由弹层按存档进入 2s / ≤60s 的查单流程。
 * window / history 都可注入，Node 单测里用假对象断言「清参数 + 落盘」。
 */

import { parseOrderReturn, type OursOrderReturn } from './api.js'
import { writeStoredOrder, type OrderStorage } from './orderStore.js'

/** 由我们负责从地址栏清掉的键（`no` 与 `out_trade_no` 是同一个单号的两种写法） */
export const ORDER_RETURN_KEYS = ['no', 'out_trade_no', 'order_token'] as const

/** 只依赖 location / history 的最小窗口形状（Node 单测里传假对象即可） */
export type OrderReturnWindow = {
  location: { search: string; pathname: string; hash: string }
  history: { replaceState: (data: unknown, unused: string, url?: string) => void }
}

/** 去掉回跳参数后的地址（剩下别的查询参数就按原样保留；没有就回到 pathname + hash） */
export const stripOrderReturn = (location: {
  search: string
  pathname: string
  hash: string
}): string => {
  const params = new URLSearchParams(location.search.startsWith('?') ? location.search.slice(1) : location.search)
  for (const key of ORDER_RETURN_KEYS) {
    params.delete(key)
  }
  const search = params.toString()
  return `${location.pathname}${search === '' ? '' : `?${search}`}${location.hash}`
}

/**
 * 读一次回跳参数：没有就返回 null（正常打开页面，不查单）；
 * 有则清掉地址栏参数 + 落盘，并把单号 / 令牌返回给调用方。
 */
export const consumeOrderReturn = (
  win: OrderReturnWindow,
  options: { now?: () => number; storage?: OrderStorage | null } = {}
): OursOrderReturn | null => {
  const parsed = parseOrderReturn(win.location.search)
  if (parsed === null) {
    return null
  }
  try {
    win.history.replaceState(null, '', stripOrderReturn(win.location))
  } catch {
    // 清不掉地址栏不影响查单本身（只是刷新会再解析一次）
  }
  writeStoredOrder(
    {
      outTradeNo: parsed.outTradeNo,
      orderToken: parsed.orderToken,
      planId: '',
      startedAt: options.now?.() ?? Date.now(),
    },
    options.storage
  )
  return parsed
}
