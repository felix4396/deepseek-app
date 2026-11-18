import { useMemo, useState } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { currentCardpayKey, cardpayPlans, fetchBalance, maskKey, redeemCard, type CardpayResult } from '../../services/cardpay.js'
import styles from './CardpayPanel.module.css'

export const CardpayPanel = ({ onClose }: { onClose: () => void }) => {
  const key = currentCardpayKey()
  const [cardNo, setCardNo] = useState('')
  const [selected, setSelected] = useState(cardpayPlans[0].id)
  const [result, setResult] = useState<CardpayResult | null>(null)
  const [balance, setBalance] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const plan = useMemo(() => cardpayPlans.find((item) => item.id === selected)!, [selected])
  const redeem = async () => {
    if (!key || !cardNo.trim()) return
    setBusy(true)
    try { setResult(await redeemCard(cardNo, key)) } finally { setBusy(false) }
  }
  const refresh = async () => {
    if (!key) return
    setBusy(true)
    try { const value = await fetchBalance(key); setBalance(value.status === 'error' ? value.message ?? '查询失败' : String(value.balance ?? '暂无余额')) } finally { setBusy(false) }
  }
  return <Modal title="购买与兑换" closable onClose={onClose} className={styles.dialog}>
    <div className={styles.intro}>用现有服务 Key 兑换卡密，或了解套餐。所有付款将在系统浏览器中完成。</div>
    <div className={styles.key}>当前目标：{key ? maskKey(key) : '未设置服务 Key'}</div>
    {!key ? <div className={styles.notice}>请先在设置中填写服务 Key，再进行兑换或查额。</div> : null}
    <section className={styles.section}><h3>套餐</h3><div className={styles.plans}>{cardpayPlans.map((item) => <button key={item.id} type="button" className={item.id === selected ? styles.planActive : styles.plan} onClick={() => setSelected(item.id)}><strong>{item.label}</strong><span>{item.priceText}</span><small>支付入口待网关配置</small></button>)}</div><Button disabled={!plan} variant="outlined">购买暂未开放</Button><p className={styles.hint}>当前网关未提供可信订单号与 pay_url，暂不生成支付链接，也不会伪造购买成功。</p></section>
    <section className={styles.section}><h3>兑换卡密</h3><input className={styles.input} value={cardNo} onChange={(event) => setCardNo(event.target.value)} placeholder="输入卡密" autoComplete="off"/><div className={styles.actions}><Button disabled={!key || !cardNo.trim() || busy} onClick={() => void redeem()}>{busy ? '处理中…' : '确认兑换'}</Button>{result ? <span className={result.status === 'error' ? styles.error : styles.success}>{result.message}</span> : null}</div></section>
    <section className={styles.section}><div className={styles.balanceHead}><h3>余额</h3><Button size="s" variant="outlined" disabled={!key || busy} onClick={() => void refresh()}>手动刷新</Button></div>{balance ? <div className={styles.balance}>{balance}</div> : <div className={styles.muted}>仅在点击刷新时查询，不会自动发送 Key。</div>}</section>
  </Modal>
}
