import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { getApiKey } from './api/apiConfig.js'

export type CardpayPlan = { id: string; label: string; priceText: string; credits: string }
export type CardpayBalance = { balance?: number; synced?: boolean; status?: string; message?: string }
export type CardpayResult = { status: 'synced' | 'pending' | 'no_downstream' | 'error'; message: string }

type CardpayBrowserPlugin = { open: (options: { url: string }) => Promise<void> }
const CardpayBrowser = registerPlugin<CardpayBrowserPlugin>('CardpayBrowser')
const CARDPAY_BASE = 'http://123.207.199.196:6012'

export const cardpayPlans: CardpayPlan[] = [
  { id: 'p1', label: '入门体验', priceText: '¥9.90 / 1M', credits: '1M' },
  { id: 'p2', label: '长期使用', priceText: '¥39 / 5M', credits: '5M' },
]
export const maskKey = (key: string) => (key.length < 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`)
const requestId = () => `redeem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
const native = () => Capacitor.isNativePlatform()

export const openCardpayBrowser = async (plan: CardpayPlan) => {
  // 建单契约尚未提供可信 pay_url/order；此入口只供接入后调用，严禁拼接 key。
  const target = `${CARDPAY_BASE}/buy?plan=${encodeURIComponent(plan.id)}`
  if (native()) return CardpayBrowser.open({ url: target })
  window.open(target, '_blank', 'noopener,noreferrer')
}

export const redeemCard = async (cardNo: string, key: string, existingRequestId?: string): Promise<CardpayResult> => {
  const id = existingRequestId ?? requestId()
  const body = { card_no: cardNo.trim(), api_key: key, request_id: id }
  try {
    const response = native()
      ? await CapacitorHttp.post({ url: `${CARDPAY_BASE}/api/redeem`, headers: { 'Content-Type': 'application/json' }, data: body, connectTimeout: 8000, readTimeout: 12000 })
      : await fetch(`${CARDPAY_BASE}/api/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const statusCode = native() ? (response as { status: number }).status : (response as Response).status
    const data = native() ? (response as { data: unknown }).data : await (response as Response).json()
    if (!(statusCode >= 200 && statusCode < 300)) {
      return { status: 'error', message: typeof data?.message === 'string' ? data.message : '卡密无效或已使用' }
    }
    const status = data?.status === 'pending' || data?.status === 'no_downstream' ? data.status : 'synced'
    return { status, message: status === 'pending' ? '额度已登记，正在同步，实际可用额度以渠道为准' : status === 'no_downstream' ? '本站已记账，模型额度尚未同步' : '兑换成功，额度已同步' }
  } catch {
    return { status: 'error', message: '网络暂时不可用，请稍后重试' }
  }
}

export const fetchBalance = async (key: string): Promise<CardpayBalance> => {
  try {
    const url = `${CARDPAY_BASE}/api/balance?api_key=${encodeURIComponent(key)}`
    const response = native() ? await CapacitorHttp.get({ url, connectTimeout: 8000, readTimeout: 12000 }) : await fetch(url)
    const statusCode = native() ? (response as { status: number }).status : (response as Response).status
    const data = native() ? (response as { data: unknown }).data : await (response as Response).json()
    if (statusCode >= 400) throw new Error('balance')
    return data
  } catch {
    return { status: 'error', message: '余额查询失败，请检查网络后重试' }
  }
}

export const currentCardpayKey = () => getApiKey()
