// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] Issue #94
//
// formatPoints 的「积分」单位必须走 i18n：en 下不许再出现中文「积分」，
// zh 下所有调用点的最终文案与修复前**逐字一致**（不许顺手改中文 UI）。
//
//   node tests/unit/format-points-i18n.test.mjs
//
// 覆盖（对应 Issue #94 关闭条件）：
//   [1] zh/en 两份都有单位 key，键名对齐
//   [2] en：输出含 points、不含「积分」（额度 / 领取 / 邀请 / 兑换 / 套餐行全部调用点）
//   [3] zh：全部调用点逐字不变（对照修复前的期望字符串）
//   [4] 数值格式化规则不变：Math.trunc + 千分位，非有限数按 0
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { formatPlanMeta, formatPlanPrice, formatPoints } = await import('../../src/services/ours/api.ts')

const failures = []
let checks = 0
const eq = (actual, expected, label) => {
  checks += 1
  if (actual !== expected) failures.push(`${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
}
const ok = (condition, label, detail = '') => {
  checks += 1
  if (!condition) failures.push(`${label}${detail === '' ? '' : `\n  ${detail}`}`)
}

const useLocale = (locale) => useSettings.setState({ locale })
/**
 * 当前语言的积分单位，从 i18n 取（修复后的调用约定）。
 * 修复前根本没有这个 key：退回空串，让下面的断言照常跑出真实输出（红），
 * 而不是在取 key 时就崩掉——`formatPoints` 修复前会忽略第二个参数，这正是要抓的 bug。
 */
const unit = () => {
  const table = useSettings.getState().locale === 'en-US' ? en : zh
  return typeof table.oursPointsUnit === 'string' ? translate('oursPointsUnit') : ''
}
const points = (value) => formatPoints(value, unit())

const p1 = { id: 'p1', name: '入门包', price: 3.0, points: 300, currency: 'CNY', enabled: true }

// ---------------------------------------------------------------- [1] 单位 key
console.log('\n[1] zh / en 都有积分单位 key，键名对齐')
{
  ok(typeof zh.oursPointsUnit === 'string' && zh.oursPointsUnit !== '', 'zh 有 oursPointsUnit')
  ok(typeof en.oursPointsUnit === 'string' && en.oursPointsUnit !== '', 'en 有 oursPointsUnit')
  eq(zh.oursPointsUnit, '积分', 'zh 单位')
  const enUnit = typeof en.oursPointsUnit === 'string' ? en.oursPointsUnit : ''
  ok(!enUnit.includes('积分'), 'en 单位不含中文「积分」', `en.oursPointsUnit=${JSON.stringify(en.oursPointsUnit)}`)
}

// ---------------------------------------------------------------- [2] en 无中文
console.log('\n[2] en：含 points、不含「积分」（全部调用点）')
{
  useLocale('en-US')
  const rendered = {
    'formatPoints(100)': points(100),
    'formatPoints(300)': points(300),
    'formatPoints(3900)': points(3900),
    'formatPlanMeta(p1)': formatPlanMeta(p1, unit()),
    'oursClaimOk': translate('oursClaimOk', { points: points(300) }),
    'oursQuotaValue': translate('oursQuotaValue', { points: points(100) }),
    'oursInviteOk': translate('oursInviteOk', { points: points(300) }),
    'oursRedeemSuccess': translate('oursRedeemSuccess', { points: points(300) }),
    'oursRedeemDuplicate': translate('oursRedeemDuplicate', { points: points(300) }),
  }
  eq(rendered['formatPoints(300)'], '300 points', 'en 额度最简文案')
  eq(rendered['formatPoints(3900)'], '3,900 points', 'en 千分位不变')
  eq(rendered['formatPlanMeta(p1)'], '¥3.00 · 300 points', 'en 套餐行')
  eq(rendered['oursClaimOk'], 'Claimed. 300 points left', 'en oursClaimOk')
  eq(rendered['oursInviteOk'], 'Bound. +300 points', 'en oursInviteOk')
  eq(rendered['oursRedeemDuplicate'], 'This card code was already redeemed; 300 points arrived', 'en oursRedeemDuplicate')
  // 红的时候这一行就是 bug 的真实输出
  console.log(`  en 实际渲染：formatPoints(100) = ${JSON.stringify(rendered['formatPoints(100)'])}`
    + ` / formatPlanMeta = ${JSON.stringify(rendered['formatPlanMeta(p1)'])}`)
  for (const [label, text] of Object.entries(rendered)) {
    ok(!text.includes('积分'), `${label} 在 en 下不含「积分」`, `实际: ${JSON.stringify(text)}`)
    ok(text.includes('points'), `${label} 在 en 下含 points`, `实际: ${JSON.stringify(text)}`)
  }
}

// ---------------------------------------------------------------- [3] zh 逐字不变
console.log('\n[3] zh：全部调用点与修复前逐字一致')
{
  useLocale('zh-CN')
  eq(points(0), '0 积分', 'zh 0')
  eq(points(100), '100 积分', 'zh 100')
  eq(points(300), '300 积分', 'zh 300')
  eq(points(3900), '3,900 积分', 'zh 千分位不变')
  // 修复前的期望字符串（改动前 ours-api.test.mjs / 界面上的实际文案），一个字节都不许动
  eq(formatPlanPrice(p1), '¥3.00', 'zh 价格文案不变')
  eq(formatPlanMeta(p1, unit()), '¥3.00 · 300 积分', 'zh 套餐行不变')
  eq(translate('oursClaimOk', { points: points(300) }), '已领取，剩余 300 积分', 'zh oursClaimOk 不变')
  eq(translate('oursQuotaValue', { points: points(300) }), '300 积分', 'zh oursQuotaValue 不变')
  eq(translate('oursQuotaValue', { points: points(100) }), '100 积分', 'zh oursQuotaValue 100 不变')
  eq(translate('oursInviteOk', { points: points(300) }), '绑定成功，+300 积分', 'zh oursInviteOk 不变')
  eq(translate('oursRedeemSuccess', { points: points(300) }), '兑换成功，+300 积分', 'zh oursRedeemSuccess 不变')
  eq(
    translate('oursRedeemDuplicate', { points: points(300) }),
    '该卡密此前已兑换，已到账 300 积分',
    'zh oursRedeemDuplicate 不变'
  )
}

// ---------------------------------------------------------------- [4] 数值规则
console.log('\n[4] 数值格式化规则不变（trunc + 千分位，非有限数按 0）')
{
  useLocale('zh-CN')
  const zhUnit = unit()
  eq(formatPoints(1234.9, zhUnit), '1,234 积分', '小数截断 + 千分位')
  eq(formatPoints(1234567, zhUnit), '1,234,567 积分', '百万级千分位')
  eq(formatPoints(Number.NaN, zhUnit), '0 积分', 'NaN → 0')
  eq(formatPoints(Number.POSITIVE_INFINITY, zhUnit), '0 积分', 'Infinity → 0')
  eq(formatPoints(-500, zhUnit), '-500 积分', '负数原样（与修复前一致）')
}

if (failures.length > 0) {
  console.error(`\nFAIL format-points-i18n：${failures.length}/${checks} 条断言不通过\n`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(`\nPASS format-points-i18n：${checks} 条断言全通过`)
