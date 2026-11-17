// 回归防线：未填 API Key 时点「测试」不应该发出任何探测请求，而是给出明确提示
// （防止再次回到「发空 Bearer」的老 bug）。
//
// 跑法：cd /root/deepseek-app && node tests/test.probe-nokey.spec.mjs
import {
  captureProbeRequests,
  clickTest,
  finish,
  openApp,
  openSettingsDataSection,
} from './helpers.mjs'

const name = 'test.probe-nokey.spec.mjs'
const { browser, page } = await openApp()
const failures = []
try {
  await openSettingsDataSection(page)

  // 输入框留空（store 里也没有已保存的 Key）
  await page.locator('input[type="password"]').first().fill('')

  const captured = captureProbeRequests(page)
  await clickTest(page)
  await page.waitForTimeout(3000)

  if (captured.length > 0) {
    failures.push(`未填 Key 却发出了请求：${captured[0].url}（authorization=${JSON.stringify(captured[0].authorization)}）`)
  } else {
    console.log('ok: 未发请求')
  }

  const hint = page.getByText(/请先填写 API Key|Enter an API Key first/)
  if ((await hint.count()) === 0) {
    failures.push('界面没有给出「请先填写 API Key」提示')
  } else {
    console.log(`ok: 提示文案 = ${JSON.stringify((await hint.first().innerText()).trim())}`)
  }
} finally {
  await finish(browser, name, failures)
}
