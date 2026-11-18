// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 新用例（1.2.3）：设置页把「服务类型」切到 Anthropic 协议后，请求路径必须换成
//   GET  /v1/models
//   POST /v1/messages
// 这两条路径由 ProviderSpec.paths 驱动，不允许在组件里写死。
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/integration/provider-anthropic.test.mjs
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  fillBaseUrl,
  fillModel,
  finish,
  openApp,
  openSettingsDataSection,
  selectProviderKind,
  sendChat,
  stubMessagesStream,
  stubModels,
} from '../helpers/helpers.mjs'

const name = 'tests/integration/provider-anthropic.test.mjs'
const KEY = 'sk-testkey-anthropic'
const BASE = 'https://anthropic.example.com'
const MODEL = 'deepseek-v4.1-flash'
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
  await stubModels(page, /\/v1\/models$/)
  await stubMessagesStream(page, /\/v1\/messages$/)
  const requests = capturePaths(page)

  await openSettingsDataSection(page)
  await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)

  await fillBaseUrl(page, BASE)
  await fillModel(page, MODEL)
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await page.waitForTimeout(300)

  // 「测试」按钮按当前 spec 打 /v1/models
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(() => requests.some((r) => r.path === '/v1/models'))
  await page.waitForTimeout(500)
  await closeSettings(page)

  await sendChat(page, '你好')
  await waitFor(() => requests.some((r) => r.method === 'POST' && r.path === '/v1/messages'))
  await page.waitForTimeout(500)

  const models = requests.filter((r) => r.path.endsWith('/models'))
  const messages = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'))

  if (models.length === 0) {
    failures.push('Anthropic 模式下没有打 GET /v1/models')
  } else if (models[0].path !== '/v1/models') {
    failures.push(`Anthropic 模式模型探测路径错误：实际 ${models[0].path}，期望 /v1/models`)
  } else {
    console.log(`ok: 模型探测 → ${models[0].path}`)
  }

  if (messages.length === 0) {
    failures.push('Anthropic 模式下没有打 POST /v1/messages')
  } else if (messages[0].path !== '/v1/messages') {
    failures.push(`Anthropic 模式发消息路径错误：实际 ${messages[0].path}，期望 /v1/messages`)
  } else {
    console.log(`ok: 发消息 → ${messages[0].path}`)
  }

  // 走的就是界面上填的服务地址
  if (messages.length > 0 && !messages[0].url.startsWith(`${BASE}/`)) {
    failures.push(`发消息没有打到填写的服务地址：${messages[0].url}`)
  }

  // Anthropic 协议下只带 x-api-key：中转的 CORS 白名单常常不允许 anthropic-version，
  // 带上会让浏览器预检直接失败（60010 实测），所以这个头必须按 spec 决定。
  if (messages.length > 0) {
    const headers = messages[0].headers
    if (headers['x-api-key'] !== KEY) {
      failures.push(`x-api-key 头不是输入框里的 key：${JSON.stringify(headers['x-api-key'])}`)
    }
    if (headers['anthropic-version']) {
      failures.push(`Anthropic 协议下不应带 anthropic-version（会被中转 CORS 拦下）：${headers['anthropic-version']}`)
    } else {
      console.log('ok: 未带 anthropic-version（避免中转 CORS 预检失败）')
    }
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
