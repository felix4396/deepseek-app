// FIXME: Test 按钮读的是 store 里已保存的 apiKey，而非输入框当前值，导致未保存时发出空 Bearer
//
// 跑法（无需在仓库安装 playwright：tests/node_modules 已软链到已有的 playwright 1.64.1）：
//   cd /root/deepseek-app && node tests/test.probe-auth.spec.mjs
//   可选环境变量：APP_URL（默认 http://100.113.135.55:5181）
//
// 用例：只在 API Key 输入框里 fill 一个假 key（不点「确定」，不写 store），
// 点服务地址那一行的「测试」，断言 /models 请求的 Authorization 头用的是输入框当前的 key。
import {
  FAKE_KEY,
  captureProbeRequests,
  clickTest,
  finish,
  openApp,
  openSettingsDataSection,
  waitForProbe,
} from './helpers.mjs'

const name = 'test.probe-auth.spec.mjs'
const { browser, page } = await openApp()
const failures = []
try {
  await openSettingsDataSection(page)

  // 只往输入框里打字，不点「确定」——store 里依旧是空的
  await page.locator('input[type="password"]').first().fill(FAKE_KEY)

  const captured = captureProbeRequests(page)
  await clickTest(page)

  if (!(await waitForProbe(page, captured))) {
    failures.push('没有捕获到 /models 请求（点「测试」后没有发出探测请求）')
  } else {
    const { url, authorization } = captured[0]
    console.log(`captured: ${url}`)
    console.log(`  authorization = ${JSON.stringify(authorization)}`)
    if (authorization !== `Bearer ${FAKE_KEY}`) {
      failures.push(
        `Authorization 头不正确：期望 "Bearer ${FAKE_KEY}"，实际 ${JSON.stringify(authorization)}`
      )
    }
  }
} finally {
  await finish(browser, name, failures)
}
