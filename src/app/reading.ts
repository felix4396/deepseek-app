import { useSettings } from '../services/settings.js'

/**
 * 消息区阅读设置（issue #102）落到 DOM：把三档写到根元素的 data-* 上，
 * src/styles/reading.css 用 `:root[data-ds-reading-*='…']` 换 token 值。
 *
 * 为什么不直接在组件里写 style：字号 / 字重 / 行高要影响一整批选择器（正文、标题、
 * 表格、思考正文、用户气泡），走根属性 + CSS 变量才只有一处真值来源。
 *
 * 首次启动（没有存过设置）时档位是默认档，CSS 默认块本身就是改造前的值，
 * 所以写不写属性观感都一样；这里仍然写一遍，界面上「当前选中项」和实际渲染才一致。
 */
const ATTR = {
  size: 'data-ds-reading-size',
  weight: 'data-ds-reading-weight',
  line: 'data-ds-reading-line',
} as const

export const applyReadingSettings = () => {
  const { readingFontSize, readingFontWeight, readingLineHeight } = useSettings.getState()
  const root = document.documentElement
  root.setAttribute(ATTR.size, readingFontSize)
  root.setAttribute(ATTR.weight, readingFontWeight)
  root.setAttribute(ATTR.line, readingLineHeight)
}

/** 只装一次：先应用当前值（避免首屏闪一下默认档），再订阅后续改动 */
export const setupReading = () => {
  applyReadingSettings()
  useSettings.subscribe(applyReadingSettings)
}
