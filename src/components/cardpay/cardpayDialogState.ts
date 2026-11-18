import { create } from 'zustand'
export const useCardpayDialog = create<{ open: boolean }>(() => ({ open: false }))
export const openCardpay = () => useCardpayDialog.setState({ open: true })
export const closeCardpay = () => useCardpayDialog.setState({ open: false })
