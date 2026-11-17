// 新用例（1.2.3）：上游把网页当接口数据返回（200 + text/html）时，
// 必须给出明确错误「上游返回网页而非接口数据，通常是路径不匹配或服务异常」，
// 并且绝不能把 HTML 渲染进消息气泡。
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/test.upstream-html.spec.mjs
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
  sendChat,
  stubModels,
} from './helpers.mjs'

const name = 'test.upstream-html.spec.mjs'
const KEY = 'sk-testkey-html'
const HTML = '<!doctype html><html><head><title>Sub2API - AI API Gateway</title></head><body>SUB2API_GATEWAY_HTML</body></html>'
const { browser, page } = await openApp()
const failures = []
const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}
try {
  await stubModels(page)
  // 上游返回网页：200 + text/html，正文是 HTML 文档
  await page.route(/\/anthropic\/v1\/messages$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: HTML,
    })
  })
  const requests = capturePaths(page)

  await openSettingsDataSection(page)
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await page.waitForTimeout(500)
  await closeSettings(page)

  await sendChat(page, '你好')
  await waitFor(() => requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages')))
  await page.waitForTimeout(2500)

  const hint = page.getByText(/上游返回网页而非接口数据/)
  if ((await hint.count()) === 0) {
    failures.push('界面上没有出现「上游返回网页而非接口数据…」的错误提示')
  } else {
    console.log(`ok: 错误提示 = ${JSON.stringify((await hint.first().innerText()).trim())}`)
  }

  // HTML 不能出现在消息气泡里
  const body = await page.locator('body').innerText()
  for (const needle of ['SUB2API_GATEWAY_HTML', '<!doctype', 'AI API Gateway']) {
    if (body.includes(needle)) {
      failures.push(`HTML 被渲染进页面：出现了 ${JSON.stringify(needle)}`)
    }
  }
  if (!body.includes('上游返回网页而非接口数据')) {
    failures.push('页面文本里找不到「上游返回网页而非接口数据」')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
