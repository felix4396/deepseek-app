import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { setApiKey, useApiConfig } from '../../services/api/apiConfig.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buyUrl,
  fetchPlans,
  formatPlanMeta,
  formatPoints,
  ORDER_STATUS_KEYS,
  OURS_PAYMENT_OPEN,
  pollOrder,
  probeApiKey,
  startCheckout,
  type OursKeyProbe,
  type OursMessageKey,
  type OursOrderStatus,
  type OursPlansState,
} from '../../services/ours/api.js'
import {
  applyForKey,
  fetchInviteProfile,
  isInviteCodeShape,
  normalizeInviteCode,
  redeemCardMigrated,
  redeemInviteCode,
  runWithDeviceSelfHeal,
  type InviteMessageKey,
  type RedeemCardResult,
  type InviteProfile,
} from '../../services/invite/api.js'
import {
  createDeviceId,
  ensureDeviceId,
  localStorageDeviceIdStorage,
  localStorageFlagStorage,
  markDeviceBackupHintSeen,
  shouldShowDeviceBackupHint,
} from '../../services/invite/device.js'
import { readStoredOrder, writeStoredOrder, ORDER_RESUME_MAX_AGE_MS } from '../../services/ours/orderStore.js'
import { httpTransport, isNativePlatform, navigateTopLevel, openCheckout } from '../../services/ours/transport.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { setOursServicesOpen, useSettingsDialog } from './settingsDialogState.js'
import styles from './OursServices.module.css'

/**
 * 「我们的渠道」的设备码 / 额度 / 邀请 / 套餐购买 / 订单 / 卡密兑换入口。
 * 整个组件只在 kind === 'ours' 时渲染（其他渠道一条 DOM 都不留，见 OursServicesRow）。
 *
 * 两套后端（都在 services/ 里，纯逻辑 + 注入传输，单测覆盖）：
 *  - 邀请 / 额度服务 http://62.106.70.167:60013（明文 HTTP）：设备码、Key、邀请码、剩余积分
 *  - 卡密 / 支付服务 https://apia.ecsafe.cn（HTTPS）：套餐、/buy 的 302 收银台、订单、卡密兑换
 *
 * 额度口径：**只认邀请服务的 remaining_points**，界面上只显示「N 积分」，不做人民币折算（#75）。
 * /api/balance 只用来判断 Key 是否有效，绝不当余额。
 *
 * 失败一律给可读文案 + 可重试，且重试都是安全的：
 *  - /apply 对同一 device_id 幂等（201 首次 / 200 已申请）
 *  - /api/redeem 用卡密本身当 request_id（同一张卡重发就是同一笔）
 *  - /buy **绝不自动重试**：每次 GET 都会新建订单
 */
type BalanceView =
  | { status: 'idle' | 'loading' }
  | { status: 'ok'; profile: InviteProfile }
  | { status: 'error'; messageKey: InviteMessageKey | OursMessageKey }

type ClaimView =
  | { status: 'idle' }
  | { status: 'busy'; auto: boolean }
  | { status: 'ok'; firstTime: boolean; points: number }
  | { status: 'error'; messageKey: InviteMessageKey }

type OrderView = {
  outTradeNo: string
  orderToken: string
  status: OursOrderStatus | null
  cardTail: string
  busy: boolean
  timedOut: boolean
  errorKey: OursMessageKey | null
}

/** 套餐列表默认选中的套餐 id（没有可用套餐就是 null） */
const firstPlanId = (state: OursPlansState | { status: 'loading' }): string | null =>
  state.status === 'success' ? (state.plans[0]?.id ?? null) : null

/** 设置页里的入口行：只有我们的渠道才出现 */
export const OursServicesRow = () => {
  const t = useTranslate()
  const kind = useApiConfig((state) => state.kind)
  // 开合状态放在 settingsDialogState：付款回跳要能直接把它打开（见 openOursServices）
  const open = useSettingsDialog((state) => state.oursOpen)
  if (kind !== 'ours') {
    return null
  }
  return (
    <>
      <div className={styles.row} data-testid="ours-services-row">
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>{t('oursServicesLabel')}</div>
          <div className={styles.rowDescription}>{t('oursServicesDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={styles.rowButton}
          data-testid="ours-services-open"
          onClick={() => setOursServicesOpen(true)}
        >
          {t('oursServicesOpen')}
        </Button>
      </div>
      {open ? <OursServicesDialog onClose={() => setOursServicesOpen(false)} /> : null}
    </>
  )
}

const OursServicesDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const apiKey = useApiConfig((state) => state.apiKey)
  /** 设备码可变：invalid_device 自愈时会重新生成一个（见 runWithDeviceSelfHeal） */
  const [deviceId, setDeviceId] = useState(() => ensureDeviceId())
  /** 设备码备份提示只提示一次（Issue #72 条件 4） */
  const [showBackupHint, setShowBackupHint] = useState(() => shouldShowDeviceBackupHint(localStorageFlagStorage()))
  const [claim, setClaim] = useState<ClaimView>({ status: 'idle' })
  const [balance, setBalance] = useState<BalanceView>({ status: 'idle' })
  const [keyProbe, setKeyProbe] = useState<OursKeyProbe | null>(null)
  /** 服务端为该设备生成的 Key 与当前已填的不同：不自动覆盖，等用户点「使用此 Key」 */
  const [pendingKey, setPendingKey] = useState('')
  const [plans, setPlans] = useState<OursPlansState | { status: 'loading' }>({ status: 'loading' })
  const [planId, setPlanId] = useState('')
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyError, setBuyError] = useState<OursMessageKey | null>(null)
  const [order, setOrder] = useState<OrderView | null>(null)
  const [inviteInput, setInviteInput] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteResult, setInviteResult] = useState<
    { kind: 'ok'; points: number } | { kind: 'error'; messageKey: InviteMessageKey } | null
  >(null)
  const [cardNo, setCardNo] = useState('')
  const [redeemBusy, setRedeemBusy] = useState(false)
  const [redeem, setRedeem] = useState<RedeemCardResult | null>(null)
  const [copied, setCopied] = useState<'device' | 'invite' | 'card' | null>(null)

  /** 完整卡密只留内存（「一键兑换」要用）：不进 localStorage、不进日志、不进文案 */
  const orderCardRef = useRef('')
  /** 关闭弹层 / 组件卸载时取消轮询 */
  const cancelled = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    cancelled.current = false
    return () => {
      alive.current = false
      cancelled.current = true
    }
  }, [])

  // ---------------------------------------------------------------- 额度 / 领取

  /**
   * 自愈依赖：device_not_found → POST /apply 重新领取并把 Key 落盘；
   * invalid_device → 重新生成设备码并持久化。两者都只重试一次（见 runWithDeviceSelfHeal）。
   */
  const saveHealedKey = (key: string) => {
    setApiKey(key)
    setPendingKey('')
  }
  const regenerateDevice = (current: string): string => {
    const next = createDeviceId()
    localStorageDeviceIdStorage().write(next)
    return next === current ? `${next}0` : next
  }
  const acknowledgeBackupHint = () => {
    markDeviceBackupHintSeen(localStorageFlagStorage())
    setShowBackupHint(false)
  }

  const refreshBalance = async () => {
    setBalance({ status: 'loading' })
    const outcome = await runWithDeviceSelfHeal(
      { deviceId, transport: httpTransport, saveKey: saveHealedKey, regenerate: regenerateDevice },
      (id) => fetchInviteProfile(id, httpTransport)
    )
    if (!alive.current) {
      return
    }
    if (outcome.deviceId !== deviceId) {
      setDeviceId(outcome.deviceId)
    }
    setBalance(
      outcome.kind === 'ok'
        ? { status: 'ok', profile: outcome.value.profile }
        : { status: 'error', messageKey: outcome.messageKey }
    )
  }

  /**
   * 领 Key（POST /apply）。
   * 自动路径只在「当前没有任何 Key」时走；手动点按钮也走这里 ——
   * 已有 Key 且与服务端下发的不一致时**不覆盖**，只提示「使用此 Key」让用户自己决定。
   */
  const claimKey = async (auto: boolean) => {
    setClaim({ status: 'busy', auto })
    const result = await applyForKey(deviceId, httpTransport)
    if (!alive.current) {
      return
    }
    if (result.kind === 'error') {
      setClaim({ status: 'error', messageKey: result.messageKey })
      return
    }
    setBalance({ status: 'ok', profile: result.profile })
    setClaim({ status: 'ok', firstTime: result.firstTime, points: result.profile.remainingPoints })
    const current = useApiConfig.getState().apiKey.trim()
    if (current === '') {
      setApiKey(result.apiKey)
    } else if (result.apiKey !== current) {
      setPendingKey(result.apiKey)
    }
    // 服务端认不认这把 Key：只用来提示，不参与额度
    const probe = await probeApiKey(result.apiKey, httpTransport)
    if (alive.current) {
      setKeyProbe(probe)
    }
  }

  // ---------------------------------------------------------------- 订单轮询

  /** 轮询状态机在 services/ours/api.ts（单测覆盖），这里只负责渲染与取消 */
  const runPoll = async (outTradeNo: string, orderToken: string) => {
    cancelled.current = false
    orderCardRef.current = ''
    setOrder({
      outTradeNo,
      orderToken,
      status: null,
      cardTail: '',
      busy: true,
      timedOut: false,
      errorKey: null,
    })
    const result = await pollOrder({
      outTradeNo,
      orderToken,
      transport: httpTransport,
      onUpdate: (next) => {
        if (!alive.current) {
          return
        }
        setOrder({
          outTradeNo,
          orderToken,
          status: next.status,
          cardTail: next.cardTail,
          busy: true,
          timedOut: false,
          errorKey: null,
        })
      },
      shouldStop: () => cancelled.current || !alive.current,
    })
    if (!alive.current || result.kind === 'cancelled') {
      return
    }
    if (result.kind === 'error') {
      setOrder((current) => (current === null ? null : { ...current, busy: false, errorKey: result.messageKey }))
      return
    }
    if (result.kind === 'ok') {
      orderCardRef.current = result.order.status === 'fulfilled' ? result.order.cardNo : ''
      setOrder((current) =>
        current === null
          ? null
          : {
              ...current,
              status: result.order.status,
              cardTail: result.order.cardTail,
              busy: false,
              timedOut: false,
            }
      )
      writeStoredOrder(null)
      // 发卡成功说明这笔钱已到账，额度可能变了：顺手刷一次
      if (result.order.status === 'fulfilled') {
        void refreshBalance()
      }
      return
    }
    // timeout：不重复下单，只留「再查一次」
    setOrder((current) => (current === null ? null : { ...current, busy: false, timedOut: true }))
  }

  const requeryOrder = async () => {
    if (order === null) {
      return
    }
    await runPoll(order.outTradeNo, order.orderToken)
  }

  // ---------------------------------------------------------------- 套餐 / 挂载

  const reloadPlans = async () => {
    setPlans({ status: 'loading' })
    const next = await fetchPlans(httpTransport)
    if (!alive.current) {
      return
    }
    setPlans(next)
    const nextId = firstPlanId(next)
    if (nextId !== null) {
      setPlanId((current) => (current === '' ? nextId : current))
    }
  }

  useEffect(() => {
    void (async () => {
      // 存档里的未完成订单（付款回跳最典型）先查：用户回来第一眼就该看到订单状态，
      // 不该排队等额度与套餐。只有存过 order_token 的才查得到。
      const stored = readStoredOrder()
      if (stored !== null && Date.now() - stored.startedAt < ORDER_RESUME_MAX_AGE_MS) {
        void runPoll(stored.outTradeNo, stored.orderToken)
      }
      if (useApiConfig.getState().apiKey.trim() === '') {
        // 首次使用：自动领取（无 Key 才会走到这里，不会覆盖用户已填的 Key）
        await claimKey(true)
      } else {
        await refreshBalance()
      }
      if (!alive.current) {
        return
      }
      const nextPlans = await fetchPlans(httpTransport)
      if (!alive.current) {
        return
      }
      setPlans(nextPlans)
      const nextId = firstPlanId(nextPlans)
      if (nextId !== null) {
        setPlanId((current) => (current === '' ? nextId : current))
      }
    })()
    // 只跑一次：挂载即初始化，之后都由用户操作驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------- 购买

  /**
   * 去支付。两种环境两种走法（Issue #36 的技术订正）：
   *
   *  - **网页版**：直接 `window.location.assign(buyUrl(planId))` —— 顶层导航。
   *    /buy 的 302 目标里签名、单号、金额后端已经拼好，浏览器照着跳就行；
   *    跨域顶层跳转不受 CORS 约束，也不需要读 Location。**一条业务请求都不发**（不发 fetch）。
   *  - **原生**：GET /buy 读 302 的 Location（CapacitorHttp disableRedirects，读不到头时
   *    走原生插件 resolveLocation 兜底）→ 系统浏览器打开 → 存 order_token → 轮询。
   *
   * 旧的网页版实现用 `fetch('/buy', { redirect: 'manual' })` 读 302：按规范只能拿到
   * opaqueredirect（读不到 Location），所以永远走到「请在 App 内购买」—— 那条分支已删除。
   */
  const buy = async () => {
    if (!OURS_PAYMENT_OPEN || planId === '' || buyBusy) {
      return
    }
    setBuyError(null)
    if (!isNativePlatform()) {
      // 网页版：让浏览器自己跳（付款回来地址栏带 ?no=&order_token=，启动时解析后进查单）
      navigateTopLevel(buyUrl(planId))
      return
    }
    setBuyBusy(true)
    const result = await startCheckout(planId, httpTransport)
    if (!alive.current) {
      return
    }
    if (result.kind !== 'ok') {
      setBuyBusy(false)
      setBuyError(result.kind === 'no-location' ? 'oursErrCheckoutUnsupported' : result.messageKey)
      return
    }
    const opened = await openCheckout(result.checkout.payUrl)
    if (!alive.current) {
      return
    }
    setBuyBusy(false)
    if (!opened) {
      setBuyError('oursErrCheckoutUnsupported')
      return
    }
    writeStoredOrder({
      outTradeNo: result.checkout.outTradeNo,
      orderToken: result.checkout.orderToken,
      planId,
      startedAt: Date.now(),
    })
    await runPoll(result.checkout.outTradeNo, result.checkout.orderToken)
  }

  // ---------------------------------------------------------------- 兑换 / 邀请

  const submitRedeem = async (card: string) => {
    const trimmed = card.trim()
    if (trimmed === '') {
      setRedeem({ kind: 'error', code: 'card_missing', messageKey: 'oursErrCardMissing', cardTail: '', retryable: false, via: 'pool' })
      return
    }
    if (apiKey.trim() === '') {
      setRedeem({ kind: 'error', code: 'api_key_missing', messageKey: 'oursErrKeyMissing', cardTail: '', retryable: false, via: 'pool' })
      return
    }
    setRedeemBusy(true)
    // 打本机池（62.106:60013/redeem-card），池整条链路不通才兜底旧 /api/redeem；
    // device_not_found / invalid_device 由 runWithDeviceSelfHeal 自愈一次，绝不循环。
    const outcome = await runWithDeviceSelfHeal(
      { deviceId, transport: httpTransport, saveKey: saveHealedKey, regenerate: regenerateDevice },
      () => redeemCardMigrated({ cardNo: trimmed, apiKey }, httpTransport)
    )
    if (!alive.current) {
      return
    }
    setRedeemBusy(false)
    if (outcome.deviceId !== deviceId) {
      setDeviceId(outcome.deviceId)
    }
    if (outcome.kind === 'error') {
      setRedeem({
        kind: 'error',
        code: outcome.code,
        messageKey: outcome.messageKey as OursMessageKey,
        cardTail: trimmed.slice(-4),
        retryable: outcome.code === 'NETWORK' || outcome.code === 'TIMEOUT',
        via: 'pool',
      })
      return
    }
    // 走到这里只可能是 success / pending（错误已在上面 return）：202 也按「收下了」处理，
    // 所以清空输入并刷新一次额度（pending 时服务端稍后才入账，用户可点「刷新额度」再看）
    setRedeem(outcome.value)
    setCardNo('')
    orderCardRef.current = ''
    void refreshBalance()
  }

  const submitInvite = async () => {
    setInviteBusy(true)
    const result = await redeemInviteCode({ deviceId, inviteCode: inviteInput }, httpTransport)
    if (!alive.current) {
      return
    }
    setInviteBusy(false)
    if (result.kind === 'error') {
      setInviteResult({ kind: 'error', messageKey: result.messageKey })
      return
    }
    setInviteResult({ kind: 'ok', points: result.rewardPoints })
    setInviteInput('')
    if (result.profile !== null) {
      setBalance({ status: 'ok', profile: result.profile })
    } else {
      void refreshBalance()
    }
  }

  const copy = async (target: 'device' | 'invite' | 'card', value: string) => {
    const done = await copyText(value)
    if (!alive.current) {
      return
    }
    setCopied(done ? target : null)
  }

  // ---------------------------------------------------------------- 渲染

  const profile = balance.status === 'ok' ? balance.profile : null
  const hasKey = apiKey.trim() !== ''
  const orderStatusText = (current: OrderView): string => {
    if (current.errorKey !== null) {
      return t(current.errorKey)
    }
    return current.status === null ? t('oursOrderChecking') : t(ORDER_STATUS_KEYS[current.status])
  }

  return (
    <Modal
      title={t('oursServicesTitle')}
      zIndex={1100}
      closable
      onClose={onClose}
      className={styles.dialog}
      mainClassName={styles.main}
    >
      <div className={styles.sections} data-testid="ours-services-dialog">
        {/* 1. 设备码：账号凭据，可见、可复制、可备份；不写日志 */}
        <section className={styles.section} data-testid="ours-device">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursDeviceTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-device-copy"
              onClick={() => void copy('device', deviceId)}
            >
              {copied === 'device' ? t('oursDeviceCopied') : t('oursDeviceCopy')}
            </Button>
          </div>
          <code className={styles.deviceCode} data-testid="ours-device-code">
            {deviceId}
          </code>
          <div className={styles.hint}>{t('oursDeviceDescription')}</div>
          {showBackupHint ? (
            <div className={styles.hint} data-testid="ours-device-backup-hint">
              {t('oursDeviceBackupHint')}{' '}
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-device-backup-hint-ok"
                onClick={acknowledgeBackupHint}
              >
                {t('oursDeviceBackupHintOk')}
              </Button>
            </div>
          ) : null}

          <div className={styles.actions}>
            <Button
              size="m"
              data-testid="ours-claim"
              disabled={claim.status === 'busy'}
              onClick={() => void claimKey(false)}
            >
              {claim.status === 'busy' && !claim.auto ? t('oursClaimBusy') : t('oursClaimAction')}
            </Button>
            {hasKey ? (
              <span className={styles.hint} data-testid="ours-claim-key">
                {t('oursClaimKeyTail', { tail: `••••${apiKey.trim().slice(-6)}` })}
              </span>
            ) : null}
          </div>

          {claim.status === 'busy' && claim.auto ? (
            <div className={styles.hint} data-testid="ours-claim-status">
              {t('oursClaimAuto')}
            </div>
          ) : null}
          {claim.status === 'ok' ? (
            <div className={clsx(styles.value, styles.valueSuccess)} data-testid="ours-claim-status">
              {claim.firstTime
                ? t('oursClaimOk', { points: formatPoints(claim.points) })
                : t('oursClaimOkExisting')}
            </div>
          ) : null}
          {claim.status === 'error' ? (
            <div className={clsx(styles.value, styles.valueError)} data-testid="ours-claim-status">
              {t(claim.messageKey)}
            </div>
          ) : null}
          {keyProbe !== null ? (
            <div className={styles.hint} data-testid="ours-key-probe">
              {keyProbe.status === 'valid'
                ? t('oursKeyProbeValid', { tail: keyProbe.keyTail })
                : keyProbe.status === 'invalid'
                  ? t('oursKeyProbeInvalid', { tail: keyProbe.keyTail })
                  : keyProbe.status === 'timeout'
                    ? t('oursKeyProbeTimeout')
                    : t('oursKeyProbeNetwork')}
            </div>
          ) : null}
          {pendingKey !== '' ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-claim-use"
                onClick={() => {
                  setApiKey(pendingKey)
                  setPendingKey('')
                }}
              >
                {t('oursClaimUseKey', { tail: `••••${pendingKey.slice(-6)}` })}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 2. 额度：只认邀请服务的 remaining_points；1 元 = 100 积分 */}
        <section className={styles.section} data-testid="ours-quota">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursQuotaTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-quota-refresh"
              disabled={balance.status === 'loading'}
              onClick={() => void refreshBalance()}
            >
              {balance.status === 'loading' ? t('oursQuotaLoading') : t('oursQuotaAction')}
            </Button>
          </div>
          <div
            role="status"
            data-testid="ours-quota-value"
            className={clsx(
              styles.value,
              balance.status === 'ok' && styles.valueSuccess,
              balance.status === 'error' && styles.valueError
            )}
          >
            {balance.status === 'ok'
              ? t('oursQuotaValue', { points: formatPoints(balance.profile.remainingPoints) })
              : balance.status === 'error'
                ? t(balance.messageKey)
                : balance.status === 'loading'
                  ? t('oursQuotaLoading')
                  : t('oursQuotaNeedsClaim')}
          </div>
          {profile !== null && profile.remainingPoints <= 0 ? (
            <div className={styles.hint} data-testid="ours-quota-hint">
              {t('oursQuotaZeroHint')}
            </div>
          ) : null}
        </section>

        {/* 3. 邀请码：自己的（可复制）+ 别人的（全部错误码） */}
        <section className={styles.section} data-testid="ours-invite">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursInviteTitle')}</h3>
            <Button
              variant="outlined"
              size="s"
              className={styles.sectionAction}
              data-testid="ours-invite-copy"
              disabled={profile === null}
              onClick={() => void copy('invite', profile?.inviteCode ?? '')}
            >
              {copied === 'invite' ? t('oursInviteCopied') : t('oursInviteCopy')}
            </Button>
          </div>
          <div className={styles.value} data-testid="ours-invite-code">
            {profile === null
              ? t('oursInviteNeedsClaim')
              : `${t('oursInviteOwnLabel')}：${profile.inviteCode}`}
          </div>
          {profile !== null ? (
            <div className={styles.hint} data-testid="ours-invite-count">
              {t('oursInviteCount', { invited: profile.invitedCount, upper: profile.maxInvites })}
            </div>
          ) : null}
          <div className={styles.redeemForm}>
            <input
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="ours-invite-input"
              placeholder={t('oursInviteInputPlaceholder')}
              aria-label={t('oursInviteInputPlaceholder')}
              value={inviteInput}
              onChange={(event) => setInviteInput(event.target.value)}
              disabled={inviteBusy}
            />
            <Button
              size="m"
              data-testid="ours-invite-submit"
              disabled={inviteBusy || normalizeInviteCode(inviteInput) === ''}
              onClick={() => void submitInvite()}
            >
              {inviteBusy ? t('oursInviteBusy') : t('oursInviteAction')}
            </Button>
          </div>
          {inviteInput !== '' && !isInviteCodeShape(inviteInput) ? (
            <div className={styles.hint}>{t('oursInviteShapeHint')}</div>
          ) : null}
          {inviteResult !== null ? (
            <div
              role="status"
              data-testid="ours-invite-result"
              className={clsx(
                styles.value,
                inviteResult.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {inviteResult.kind === 'error'
                ? t(inviteResult.messageKey)
                : t('oursInviteOk', { points: formatPoints(inviteResult.points) })}
            </div>
          ) : null}
        </section>

        {/* 4. 套餐 + 购买：价格与积分来自 /api/plans，App 不硬编码 */}
        <section className={styles.section} data-testid="ours-plans">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursPlansTitle')}</h3>
            {plans.status === 'error' ? (
              <Button
                variant="outlined"
                size="s"
                className={styles.sectionAction}
                data-testid="ours-plans-retry"
                onClick={() => void reloadPlans()}
              >
                {t('oursPlansRetry')}
              </Button>
            ) : null}
          </div>
          {plans.status === 'loading' ? (
            <div className={styles.hint}>{t('oursPlansLoading')}</div>
          ) : plans.status === 'error' ? (
            <div className={clsx(styles.value, styles.valueError)}>{t(plans.messageKey)}</div>
          ) : (
            <ul className={styles.plans}>
              {plans.plans.map((plan) => (
                <li key={plan.id}>
                  <button
                    type="button"
                    className={clsx(styles.plan, plan.id === planId && styles.planActive)}
                    aria-pressed={plan.id === planId}
                    data-testid={`ours-plan-${plan.id}`}
                    onClick={() => setPlanId(plan.id)}
                  >
                    <span className={styles.planName}>{plan.name}</span>
                    <span className={styles.planMeta}>{formatPlanMeta(plan)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.actions}>
            <Button
              size="m"
              data-testid="ours-buy"
              disabled={!OURS_PAYMENT_OPEN || buyBusy || planId === ''}
              onClick={() => void buy()}
            >
              {buyBusy ? t('oursBuyBusy') : t('oursBuyAction')}
            </Button>
          </div>
          <div
            className={clsx(styles.hint, buyError !== null && styles.valueError)}
            data-testid="ours-pay-notice"
          >
            {buyError !== null
              ? t(buyError)
              : isNativePlatform()
                ? t('oursBuyHint')
                : t('oursBuyWebHint')}
          </div>
        </section>

        {/* 5. 订单：待支付 → 已发卡；超时只说「稍后再看」，不重复下单 */}
        {order !== null ? (
          <section className={styles.section} data-testid="ours-order">
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>{t('oursOrderTitle')}</h3>
              {order.timedOut || order.errorKey !== null ? (
                <Button
                  variant="outlined"
                  size="s"
                  className={styles.sectionAction}
                  data-testid="ours-order-requery"
                  disabled={order.busy}
                  onClick={() => void requeryOrder()}
                >
                  {t('oursOrderRequery')}
                </Button>
              ) : null}
            </div>
            <div
              role="status"
              data-testid="ours-order-status"
              className={clsx(
                styles.value,
                order.status === 'fulfilled' && styles.valueSuccess,
                (order.timedOut || order.errorKey !== null) && styles.valueError
              )}
            >
              {orderStatusText(order)}
            </div>
            {order.busy ? (
              <div className={styles.hint} data-testid="ours-order-waiting">
                {t('oursOrderWaiting')}
              </div>
            ) : null}
            {order.timedOut ? (
              <div className={styles.hint} data-testid="ours-order-timeout">
                {t('oursOrderTimeout')}
              </div>
            ) : null}
            {order.status === 'fulfilled' && order.cardTail !== '' ? (
              <>
                <div className={styles.value} data-testid="ours-order-card">
                  {t('oursOrderCard', { tail: order.cardTail })}
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="outlined"
                    size="s"
                    data-testid="ours-order-copy"
                    onClick={() => void copy('card', orderCardRef.current)}
                  >
                    {copied === 'card' ? t('oursOrderCopyCardDone') : t('oursOrderCopyCard')}
                  </Button>
                  <Button
                    size="s"
                    data-testid="ours-order-redeem"
                    disabled={redeemBusy}
                    onClick={() => void submitRedeem(orderCardRef.current)}
                  >
                    {redeemBusy ? t('oursRedeemBusy') : t('oursOrderRedeem')}
                  </Button>
                </div>
              </>
            ) : null}
          </section>
        ) : null}

        {/* 6. 卡密兑换（手输与发卡后一键兑换共用同一套语义） */}
        <section className={styles.section} data-testid="ours-redeem">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle}>{t('oursRedeemTitle')}</h3>
          </div>
          <div className={styles.redeemForm}>
            <input
              className={styles.input}
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              data-testid="ours-redeem-input"
              placeholder={t('oursRedeemPlaceholder')}
              aria-label={t('oursRedeemPlaceholder')}
              value={cardNo}
              onChange={(event) => setCardNo(event.target.value)}
              disabled={redeemBusy}
            />
            <Button
              size="m"
              data-testid="ours-redeem-submit"
              disabled={redeemBusy || !hasKey}
              onClick={() => void submitRedeem(cardNo)}
            >
              {redeemBusy ? t('oursRedeemBusy') : t('oursRedeemAction')}
            </Button>
          </div>
          {redeem !== null ? (
            <div
              role="status"
              data-testid="ours-redeem-result"
              className={clsx(
                styles.value,
                redeem.kind === 'error' ? styles.valueError : styles.valueSuccess
              )}
            >
              {redeem.kind === 'error'
                ? t(redeem.messageKey)
                : redeem.kind === 'pending'
                  ? // 202（CREDIT_PENDING / VERIFY_PENDING）只有一种说法：处理中，稍后自动到账
                    t('oursRedeemProcessing')
                  : redeem.messageKey === 'oursRedeemDuplicate'
                    ? t('oursRedeemDuplicate', { points: formatPoints(redeem.points) })
                    : t('oursRedeemSuccess', { points: formatPoints(redeem.points) })}
              {redeem.cardTail === '' ? '' : `（${redeem.cardTail}）`}
            </div>
          ) : null}
          {redeem !== null && redeem.kind === 'pending' ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-redeem-refresh"
                disabled={balance.status === 'loading'}
                onClick={() => void refreshBalance()}
              >
                {t('oursRedeemRefreshBalance')}
              </Button>
            </div>
          ) : null}
          {redeem !== null && redeem.kind === 'error' && redeem.retryable ? (
            <div className={styles.actions}>
              <Button
                variant="outlined"
                size="s"
                data-testid="ours-redeem-retry"
                disabled={redeemBusy}
                onClick={() => void submitRedeem(cardNo)}
              >
                {t('oursRedeemRetry')}
              </Button>
            </div>
          ) : null}
        </section>

        {/* 7. 安全说明：明文 HTTP 的邀请服务与 HTTPS 的支付服务混用，说清楚但不吓人 */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t('oursSecurityTitle')}</h3>
          <div className={styles.hint} data-testid="ours-security-notice">
            {t('oursSecurityNotice')}
          </div>
        </section>
      </div>
    </Modal>
  )
}
