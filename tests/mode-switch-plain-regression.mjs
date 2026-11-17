// 正式包（非内测）回归：deepseek spec 下「深度思考 / 智能搜索 / 附件 / 语音」入口一个不少，
// 并逐项对比改动前的 baseline 包，证明空态加的模式切换没有动到输入区。
//
//   cd /root/deepseek-app && node tests/mode-switch-plain-regression.mjs
//
// 需要先把两套静态产物起在本地（见 docs/ui 说明）：
//   python3 -m http.server 5191 --directory dist-plain      # 当前源码的正式包
//   python3 -m http.server 5192 --directory dist-baseline   # 改动前的 baseline 包
const PLAIN_URL = process.env.PLAIN_URL || 'http://127.0.0.1:5191'
const BASELINE_URL = process.env.BASELINE_URL || 'http://127.0.0.1:5192'

import { chromium } from 'playwright'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const expect = (cond, message, detail) => {
  if (cond) {
    ok(detail ? `${message}（${detail}）` : message)
  } else {
    bad(detail ? `${message}（实际：${detail}）` : message)
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 读出输入区（含所有功能性按钮）的可见文案/aria-label 列表 */
const readFunctionRow = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('textarea')?.closest('div[class*="wrapper"]')?.parentElement
    const scope = row ?? document.body
    return [...scope.querySelectorAll('button')]
      .map((button) => {
        const label = button.getAttribute('aria-label') || button.textContent?.trim() || ''
        const style = getComputedStyle(button)
        return style.display === 'none' || style.visibility === 'hidden' ? null : label
      })
      .filter(Boolean)
  })

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
})
const consoleErrors = []

const open = async (url) => {
  const page = await context.newPage()
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${url} :: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`${url} :: ${String(error)}`))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.localStorage.clear()
    // 种一个 API Key，避免空态自动弹「设置」挡住输入区（与本用例无关）
    window.localStorage.setItem('chat-demo:api-key', 'sk-plain-regression-0001')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('textarea').first().waitFor({ timeout: 15000 })
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  return page
}

console.log('\n[1] 当前正式包：输入区入口齐全')
const page = await open(PLAIN_URL)
const labels = await readFunctionRow(page)
for (const name of [/深度思考/, /智能搜索/, /上传文件|附件/, /语音|Voice/]) {
  expect(labels.some((label) => name.test(label)), `入口仍在：${name}`, labels.join(' / '))
}

const think = page.getByRole('button', { name: /深度思考/ }).first()
const search = page.getByRole('button', { name: /智能搜索/ }).first()
await think.click()
await search.click()
await wait(120)
expect((await think.getAttribute('aria-pressed')) === 'true', '深度思考可切换')
expect((await search.getAttribute('aria-pressed')) === 'true', '智能搜索可切换')
await think.click()
await search.click()

const textarea = page.locator('textarea').first()
await textarea.type('正式包回归输入')
expect((await textarea.inputValue()) === '正式包回归输入', '输入框可正常输入')

const modeVisible = await page.getByRole('group', { name: /对话模式|Chat mode/ }).isVisible()
expect(modeVisible, '正式包里模式切换同样渲染在问候语下方')

const styles = await page.evaluate(() => {
  const fast = document.querySelector('button[data-mode="fast"]')
  const expert = document.querySelector('button[data-mode="expert"]')
  return {
    fast: { bg: getComputedStyle(fast).backgroundColor, color: getComputedStyle(fast).color },
    expert: { bg: getComputedStyle(expert).backgroundColor, color: getComputedStyle(expert).color },
  }
})
expect(
  styles.fast.bg === 'rgb(232, 237, 255)' && styles.fast.color === 'rgb(77, 107, 254)',
  '正式包默认选中「快速模式」',
  `${styles.fast.bg} / ${styles.fast.color}`
)

console.log('\n[2] 与 baseline 包对比输入区按钮清单')
const baseline = await open(BASELINE_URL)
const baselineLabels = await readFunctionRow(baseline)
const normalize = (list) => [...new Set(list)].sort()
const same =
  JSON.stringify(normalize(labels.filter((label) => !/模式/.test(label)))) ===
  JSON.stringify(normalize(baselineLabels))
expect(
  same,
  '输入区功能性按钮与 baseline 完全一致',
  `current=[${normalize(labels).join(' | ')}] baseline=[${normalize(baselineLabels).join(' | ')}]`
)
const baselineHasMode = await baseline
  .getByRole('group', { name: /对话模式|Chat mode/ })
  .count()
expect(baselineHasMode === 0, 'baseline 包确实没有模式切换（对比基准有效）')

expect(consoleErrors.length === 0, 'console error = 0', consoleErrors.join(' | '))

await browser.close()
if (failures.length === 0) {
  console.log('\n正式包回归通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
