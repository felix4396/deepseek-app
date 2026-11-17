// 回归防线 1.2.2 → 1.2.3：默认「DeepSeek 官方」服务类型下，三条请求路径必须与改造前逐字一致：
//   GET  /models                （点「测试」/ 保存 API Key 时的探测）
//   POST /anthropic/v1/messages （发消息）
//   POST /v1/tools/asr          （语音输入）
// 路径一旦漂移，官方接口立刻不可用，所以这里按字符串全等断言。
//
// 跑法（需要 localhost 这类安全上下文才能用麦克风）：
//   APP_URL=http://127.0.0.1:5181 node tests/test.paths-deepseek.spec.mjs
import {
  capturePaths,
  clickApiKeyConfirm,
  closeSettings,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
  recordVoice,
  sendChat,
  stubAsr,
  stubMessagesStream,
  stubModels,
} from './helpers.mjs'

const name = 'test.paths-deepseek.spec.mjs'
const KEY = 'sk-testkey-deepseek'
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
  await stubMessagesStream(page)
  await stubAsr(page)
  const requests = capturePaths(page)

  await openSettingsDataSection(page)
  await fillApiKey(page, KEY)
  await clickApiKeyConfirm(page)
  await waitFor(() => requests.some((r) => r.path.endsWith('/models')))
  await closeSettings(page)

  await sendChat(page, '你好')
  await waitFor(() => requests.some((r) => r.method === 'POST' && r.path.endsWith('/messages')))
  await page.waitForTimeout(500)

  await recordVoice(page)
  await waitFor(() => requests.some((r) => r.path.endsWith('/v1/tools/asr')), 20000)

  const models = requests.filter((r) => r.path.endsWith('/models'))
  const messages = requests.filter((r) => r.method === 'POST' && r.path.endsWith('/messages'))
  const asr = requests.filter((r) => r.path.endsWith('/v1/tools/asr'))

  const check = (label, list, expected) => {
    if (list.length === 0) {
      failures.push(`没有捕获到 ${label} 请求（期望路径 ${expected}）`)
      return
    }
    const path = list[0].path
    if (path !== expected) {
      failures.push(`${label} 路径变了：实际 ${path}，期望 ${expected}`)
    } else {
      console.log(`ok: ${label} → ${path}`)
    }
  }

  check('GET /models', models, '/models')
  check('POST messages', messages, '/anthropic/v1/messages')
  check('POST asr', asr, '/v1/tools/asr')
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
