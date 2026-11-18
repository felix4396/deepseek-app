import type { TranslationKey } from '../../i18n/index.js'

/**
 * 首字等待的分级提示：请求发出后按等待时长逐级升级，收到第一个 token 或本轮结束就撤下。
 * 5s「正在等待响应」→ 30s「服务响应较慢，仍在等待」→ 60s「等待过久，可停止后重新生成」。
 *
 * 这里只描述「等多久该说什么」，定时器挂在 chat/store 的 streamReply 里，
 * 消息组件只按 key 取文案，所以分档规则可以脱离 UI 单测。
 */
export type StreamNoticeTier = {
  /** 从请求发出算起，等待超过这个时长就升到这一档 */
  afterMs: number
  key: TranslationKey
  /** 最高档要给用户可点的出口（停止 / 重新生成） */
  actions: boolean
}

export const STREAM_NOTICE_TIERS: readonly StreamNoticeTier[] = [
  { afterMs: 5_000, key: 'replyWaitingFirstToken', actions: false },
  { afterMs: 30_000, key: 'replyWaitingSlow', actions: false },
  { afterMs: 60_000, key: 'replyWaitingStalled', actions: true },
]

/** 每档要挂的定时器延时（毫秒），与 STREAM_NOTICE_TIERS 一一对应 */
export const STREAM_NOTICE_DELAYS: readonly number[] = STREAM_NOTICE_TIERS.map(
  (tier) => tier.afterMs
)

/** 当前等待时长该显示哪一档；连第一档都没到就是 null（还在正常出字时间内，不打扰） */
export const streamNoticeTier = (elapsedMs: number): StreamNoticeTier | null =>
  STREAM_NOTICE_TIERS.reduce<StreamNoticeTier | null>(
    (current, tier) => (elapsedMs >= tier.afterMs ? tier : current),
    null
  )

/** 当前这条提示是否要带停止/重新生成入口 */
export const hasStreamNoticeActions = (key: TranslationKey | undefined): boolean =>
  key !== undefined && STREAM_NOTICE_TIERS.some((tier) => tier.key === key && tier.actions)
