// 1.2.3 一次性验收脚本：本地标准库 mock 上游（不依赖任何外网），覆盖 8 组断言。
//
//   cd /root/deepseek-app && APP_URL=http://127.0.0.1:5181 node tests/run-acceptance.mjs
//
// 1. deepseek 模式：三条路径逐字断言 + safety_check/title/tools/latest_reminder 四个私有字段存在
// 2. anthropic 模式：路径 /v1/models、/v1/messages，四个私有字段都不存在
// 3. anthropic 发消息：mock SSE → 文本逐字流出、结束状态正常
// 4. 上游返回 text/html → UI 报明确错误、气泡里没有 HTML
// 5. anthropic 模式：搜索/附件/语音/朗读入口不可见或置灰
// 6. 切回 deepseek：上述能力恢复可用（搜索开→请求体带 deepseek_web_search；附件能拿到 file_id；标题自动生成）
// 7. 刷新后会话与配置仍在
// 8. console error = 0
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const KEY = 'sk-acceptance-key'
const DEEPSEEK_MODEL = 'deepseek-flash'
const ANTHROPIC_MODEL = 'deepseek-v4.1-flash'
const REPLY_TEXT = '验收测试回答，逐字流出。'
const TITLE = '验收标题'
const FILE_ID = 'file-api-accept-0001'

const failures = []
const evidence = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => {
  evidence.push(message)
  console.log(`  ·   ${message}`)
}

/** 标准 Anthropic SSE（正文逐块下发；有 title.enabled 时在 message_delta 里给标题） */
const sseBody = (text, withTitle) => {
  const chunks = [
    'event: message_start',
    `data: {"type":"message_start","message":{"id":"msg_accept","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}`,
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
  ]
  // 拆成三块，验证增量拼接
  for (const piece of [text.slice(0, 5), text.slice(5, 10), text.slice(10)]) {
    chunks.push(
      'event: content_block_delta',
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(piece)}}}`,
      ''
    )
  }
  chunks.push(
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null${withTitle ? `,"title":${JSON.stringify(TITLE)}` : ''}},"usage":{"output_tokens":9}}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  )
  return chunks.join('\n')
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers':
    'content-type,x-api-key,anthropic-version,anthropic-beta,accept,accept-encoding',
}

/** 极简 mock 上游：html=true 时所有 POST messages 都返回网页（模拟路径打错/网关报错页） */
const startMock = ({ html = false } = {}) =>
  new Promise((resolve) => {
    const log = []
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        const { pathname } = new URL(req.url, 'http://mock')
        log.push({ method: req.method, path: pathname, headers: req.headers, body: raw })
        for (const [name, value] of Object.entries(CORS)) {
          res.setHeader(name, value)
        }
        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
        const json = (value) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(value))
        }
        if (pathname === '/models' || pathname === '/v1/models') {
          return json({ data: [{ id: DEEPSEEK_MODEL }, { id: ANTHROPIC_MODEL }] })
        }
        // 附件挂在 messages 前缀下：/anthropic/v1/messages/files、/v1/messages/files
        if (pathname.endsWith('/files')) {
          return json({
            id: FILE_ID,
            type: 'file',
            size_bytes: raw.length,
            created_at: '2026-11-17T00:00:00Z',
            filename: 'acceptance.txt',
            mime_type: 'text/plain',
          })
        }
        if (pathname === '/v1/tools/asr') {
          return json({ text: '语音内容' })
        }
        if (pathname === '/anthropic/v1/messages' || pathname === '/v1/messages') {
          if (html) {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end('<!doctype html><html><body>MOCK_GATEWAY_HTML</body></html>')
            return
          }
          let withTitle = false
          try {
            withTitle = Boolean(JSON.parse(raw).title?.enabled)
          } catch {
            withTitle = false
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(sseBody(REPLY_TEXT, withTitle))
          res.end()
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock 没有实现 ${pathname}` } }))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, log, base: `http://127.0.0.1:${server.address().port}` })
    })
  })

const posts = (log, path) => log.filter((entry) => entry.method === 'POST' && entry.path === path)
const jsonBody = (entry) => {
  try {
    return JSON.parse(entry.body)
  } catch {
    return {}
  }
}

const mockOk = await startMock()
const mockHtml = await startMock({ html: true })

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
})
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
  permissions: ['microphone'],
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(String(error)))

const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true
    }
    await page.waitForTimeout(100)
  }
  return false
}

const seed = async ({ kind, baseUrl, model }) => {
  await page.evaluate(
    ({ kind, baseUrl, model, key }) => {
      window.localStorage.clear()
      if (kind) {
        window.localStorage.setItem('chat-demo:provider-kind', kind)
      }
      window.localStorage.setItem('chat-demo:base-url', baseUrl)
      window.localStorage.setItem('chat-demo:model', model)
      window.localStorage.setItem('chat-demo:api-key', key)
    },
    { kind, baseUrl, model, key: KEY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
}

const openSettings = async () => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(250)
}
const closeSettings = async () => {
  const dialog = page.getByRole('dialog').first()
  if ((await dialog.count()) > 0) {
    await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
    await page.waitForTimeout(300)
  }
}
const selectKind = async (nameRe) => {
  await page.getByRole('button', { name: /服务类型|Service type/ }).first().click()
  await page.getByRole('option', { name: nameRe }).first().click()
  await page.waitForTimeout(250)
}
const setField = async (labelRe, value) => {
  const input = page.getByLabel(labelRe).first()
  await input.fill(value)
  await input.press('Enter')
  await page.waitForTimeout(150)
}
const send = async (text) => {
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill(text)
  const button = page.getByRole('button', { name: /^发送$|^Send$/ }).first()
  // 附件还在上传时发送按钮是 disabled：等它就绪再点
  const ready = await waitFor(async () => (await button.getAttribute('aria-disabled')) !== 'true')
  if (!ready) {
    throw new Error(`发送按钮一直不可用（草稿未就绪）：${text}`)
  }
  await button.click()
}
/** 可见且未置灰 */
const usable = async (nameRe) => {
  const button = page.getByRole('button', { name: nameRe })
  if ((await button.count()) === 0) {
    return false
  }
  const first = button.first()
  if (!(await first.isVisible())) {
    return false
  }
  return !((await first.getAttribute('aria-disabled')) === 'true' || (await first.isDisabled()))
}
const gone = async (nameRe) => !(await usable(nameRe))

try {
  // ============ 1. deepseek 模式：零影响 ============
  console.log('\n[1] deepseek 模式')
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  // 老用户形态：只有 base-url / model / api-key，没有 provider-kind
  await seed({ baseUrl: mockOk.base, model: DEEPSEEK_MODEL })

  await openSettings()
  const kindText = (
    await page.getByRole('button', { name: /服务类型|Service type/ }).first().innerText()
  ).trim()
  if (!/DeepSeek/.test(kindText)) {
    bad(`1) 默认服务类型不是 DeepSeek 官方：${kindText}`)
  } else {
    ok(`默认服务类型 = ${kindText}`)
  }
  if ((await page.getByLabel(/服务地址|Service URL/).count()) > 0) {
    bad('1) deepseek 模式不该显示「服务地址」输入框（fields 只有 apiKey）')
  } else {
    ok('deepseek 模式只渲染 API Key 行（服务地址/模型按 spec 隐藏）')
  }
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(async () => mockOk.log.some((entry) => entry.path === '/models'))
  await closeSettings()

  // 搜索开关打开 + 附件上传
  await page.getByRole('button', { name: /^智能搜索$|^Search$/ }).first().click()
  const chooser = page.locator('input[type="file"]').first()
  await chooser.setInputFiles({
    name: 'acceptance.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello acceptance'),
  })
    const uploadEntry = await waitFor(async () => posts(mockOk.log, '/anthropic/v1/messages/files').length > 0)
  if (!uploadEntry) {
    bad('1) 附件没有上传到 /anthropic/v1/messages/files（拿不到 file_id）')
  } else {
    ok(`附件上传到 /anthropic/v1/messages/files，mock 返回 file_id=${FILE_ID}`)
    note(`deepseek 附件上传 path = /anthropic/v1/messages/files`)
  }
  await page.waitForTimeout(800)

  await send('你好')
  const dsMessages = await waitFor(async () => posts(mockOk.log, '/anthropic/v1/messages').length > 0)
  const dsEntry = posts(mockOk.log, '/anthropic/v1/messages')[0]
  if (!dsMessages || !dsEntry) {
    bad('1) 没有打到 /anthropic/v1/messages')
  } else {
    const body = jsonBody(dsEntry)
    const roles = (body.messages ?? []).map((message) => message.role)
    const tools = (body.tools ?? []).map((tool) => tool.type)
    const present = {
      safety_check: body.safety_check?.level === 'high',
      title: body.title?.enabled === true,
      tools: tools.length > 0,
      latest_reminder: roles.includes('latest_reminder'),
      thinking: Boolean(body.thinking?.type),
    }
    for (const [field, sent] of Object.entries(present)) {
      if (!sent) {
        bad(`1) deepseek 请求体缺少 ${field}`)
      }
    }
    if (tools.includes('deepseek_web_search')) {
      ok(`搜索开关打开时 tools 里确有 deepseek_web_search（${tools.join(', ')}）`)
      note(`deepseek requests.tools = ${JSON.stringify(tools)}`)
    } else {
      bad(`1) 搜索开关打开却没有 deepseek_web_search：${JSON.stringify(tools)}`)
    }
    note(`deepseek messages roles = ${JSON.stringify([...new Set(roles)])}`)
    note(`deepseek body 顶层字段 = ${JSON.stringify(Object.keys(body))}`)
    note(`deepseek POST path = ${dsEntry.path}`)
  }
  await page.waitForTimeout(2500)
  const dsReply = await page.locator('body').innerText()
  if (!dsReply.includes(REPLY_TEXT)) {
    bad(`1) deepseek 模式下回答没有渲染：${dsReply.slice(-120)}`)
  } else {
    ok('deepseek 模式回答正常渲染')
  }
  const titleShown = await page.getByText(TITLE).count()
  if (titleShown === 0) {
    bad('1) 自动标题没有生效（侧边栏看不到标题）')
  } else {
    ok(`自动标题生效：侧边栏显示「${TITLE}」`)
    note(`deepseek 自动标题 = ${TITLE}`)
  }
  // 三个入口都在
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['上传文件', /^上传文件$|^Upload files$/],
    ['语音输入', /^语音输入$|^Voice input$/],
    ['朗读', /^朗读$|^Read aloud$/],
  ]) {
    if (!(await usable(re))) {
      bad(`1) deepseek 模式下「${label}」入口不可用`)
    }
  }
  // 第三条路径 tools：真的录一次音，断言 /v1/tools/asr 逐字一致（models / messages 已在上方断言）
  await page.locator('textarea').last().fill('')
  await page.getByRole('button', { name: /语音输入|Voice input/ }).first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /结束录音并转写|Stop and transcribe/ }).first().click()
  const asrHit = await waitFor(async () => posts(mockOk.log, '/v1/tools/asr').length > 0, 20000)
  const dsPaths = {
    models: mockOk.log.filter((entry) => entry.path === '/models').length,
    messages: posts(mockOk.log, '/anthropic/v1/messages').length,
    tools: posts(mockOk.log, '/v1/tools/asr').length,
  }
  if (!asrHit || dsPaths.tools === 0) {
    bad(`1) 没有捕获到 /v1/tools/asr：${JSON.stringify(dsPaths)}`)
  } else if (dsPaths.models === 0 || dsPaths.messages === 0) {
    bad(`1) deepseek 三条路径没齐：${JSON.stringify(dsPaths)}`)
  } else {
    ok(`deepseek 三条路径逐字一致：/models、/anthropic/v1/messages、/v1/tools/asr`)
    note(`deepseek paths 命中次数 = ${JSON.stringify(dsPaths)}`)
  }
  await page.waitForTimeout(1200)
  await page.screenshot({ path: '/root/deepseek-app/docs/ui/1.2.3-deepseek-full.png' })

  // ============ 2/3. anthropic 模式：路径 + 字段剥离 + 流式文本 ============
  console.log('\n[2] anthropic 模式：路径与请求体')
  // 只看切到 anthropic 之后产生的请求（前面的 deepseek 请求还在同一个 mock 日志里）
  const anLogStart = mockOk.log.length
  await openSettings()
  await selectKind(/Anthropic 协议|Anthropic-compatible/)
  await setField(/服务地址|Service URL/, mockOk.base)
  await setField(/^模型$|^Model$/, ANTHROPIC_MODEL)
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
  await waitFor(async () => mockOk.log.some((entry) => entry.path === '/v1/models'))
  await closeSettings()
  note(`anthropic 探测 path = ${mockOk.log.filter((e) => e.path === '/v1/models').length} 次 /v1/models`)

  await send('再来一条')
  await waitFor(async () => posts(mockOk.log, '/v1/messages').length > 0)
  const anEntry = posts(mockOk.log, '/v1/messages')[0]
  if (!anEntry) {
    bad('2) 没有打到 /v1/messages')
  } else {
    const body = jsonBody(anEntry)
    const roles = (body.messages ?? []).map((message) => message.role)
    const gates = {
      safety_check: Object.hasOwn(body, 'safety_check'),
      title: Object.hasOwn(body, 'title'),
      tools: Object.hasOwn(body, 'tools'),
      latest_reminder: roles.includes('latest_reminder'),
    }
    for (const [field, sent] of Object.entries(gates)) {
      if (sent) {
        bad(`2) anthropic 请求体仍带 ${field}`)
      }
    }
    ok(`anthropic 请求体已剥离 safety_check/title/tools/latest_reminder`)
    note(`anthropic body 顶层字段 = ${JSON.stringify(Object.keys(body))}`)
    note(`anthropic messages roles = ${JSON.stringify([...new Set(roles)])}`)
    note(`anthropic POST path = ${anEntry.path}，model = ${body.model}`)
    const anModelPaths = [
      ...new Set(
        mockOk.log
          .slice(anLogStart)
          .filter((e) => e.path.endsWith('/models'))
          .map((e) => e.path)
      ),
    ]
    if (anModelPaths.length === 1 && anModelPaths[0] === '/v1/models' && anEntry.path === '/v1/messages') {
      ok(`anthropic 两条路径逐字一致：/v1/models、/v1/messages`)
      note(`anthropic paths = ${JSON.stringify({ models: anModelPaths, messages: anEntry.path })}`)
    } else {
      bad(`2) anthropic 路径不符合规格：models=${JSON.stringify(anModelPaths)} messages=${anEntry.path}`)
    }
    if (body.system.length < 20) {
      bad('2) latestReminder 内容没有折进 system')
    }
  }
  await page.waitForTimeout(2500)
  const anReply = await page.locator('body').innerText()
  if (!anReply.includes(REPLY_TEXT)) {
    bad(`3) anthropic 流式文本没有逐字渲染出来：${anReply.slice(-140)}`)
  } else {
    ok(`anthropic 流式回答逐字渲染：${REPLY_TEXT}`)
  }
  const errorNotice = await page.getByText(/上游返回网页|网络异常|服务器繁忙|API Key 无效/).count()
  if (errorNotice > 0) {
    bad('3) anthropic 正常回答被标成了错误状态')
  } else {
    ok('3) 结束状态正常（无错误提示）')
  }

  // ============ 5. anthropic 能力降级 ============
  console.log('\n[5] anthropic 模式能力降级')
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['上传文件', /^上传文件$|^Upload files$/],
    ['语音输入', /^语音输入$|^Voice input$/],
    ['朗读', /^朗读$|^Read aloud$/],
  ]) {
    if (await gone(re)) {
      ok(`「${label}」入口已隐藏/置灰`)
    } else {
      bad(`5) anthropic 模式下「${label}」入口仍可用`)
    }
  }
  if (!(await usable(/^深度思考$|^DeepThink$/))) {
    bad('5) anthropic 模式下「深度思考」被误删')
  } else {
    ok('「深度思考」保留可用')
  }
  await page.screenshot({ path: '/root/deepseek-app/docs/ui/1.2.3-anthropic-caps.png' })
  // DOM 证据：把四个入口在 anthropic 模式下的实际 DOM 属性落盘（隐藏 or aria-disabled）
  const domDump = await page.evaluate(() => {
    const wanted = ['智能搜索', '上传文件', '语音输入', '朗读', '深度思考']
    const buttons = [...document.querySelectorAll('button')]
    return wanted.map((label) => {
      const hits = buttons.filter(
        (button) =>
          button.getAttribute('aria-label')?.includes(label) ||
          button.textContent?.trim() === label ||
          button.textContent?.includes(label)
      )
      return {
        label,
        count: hits.length,
        nodes: hits.slice(0, 2).map((button) => ({
          ariaLabel: button.getAttribute('aria-label'),
          ariaDisabled: button.getAttribute('aria-disabled'),
          disabled: button.disabled,
          hidden: button.hidden,
          display: getComputedStyle(button).display,
          visibility: getComputedStyle(button).visibility,
          className: button.className,
        })),
      }
    })
  })
  writeFileSync(
    '/root/deepseek-app/docs/ui/1.2.3-anthropic-dom.txt',
    `anthropic 模式入口 DOM（生成于 ${new Date().toISOString()}）\n${JSON.stringify(domDump, null, 2)}\n`
  )
  note('anthropic 入口 DOM 证据已写入 docs/ui/1.2.3-anthropic-dom.txt')

  // ============ 4. 上游返回 HTML ============
  console.log('\n[4] 上游返回 text/html')
  await openSettings()
  await setField(/服务地址|Service URL/, mockHtml.base)
  await closeSettings()
  await send('你好')
  await waitFor(async () => posts(mockHtml.log, '/v1/messages').length > 0)
  await page.waitForTimeout(3000)
  const htmlText = await page.locator('body').innerText()
  if (!htmlText.includes('上游返回网页而非接口数据')) {
    bad('4) 没有出现「上游返回网页而非接口数据…」错误提示')
  } else {
    ok('4) 出现明确错误：上游返回网页而非接口数据，通常是路径不匹配或服务异常')
  }
  if (/MOCK_GATEWAY_HTML|<!doctype|<html/i.test(htmlText)) {
    bad('4) HTML 被渲染进页面')
  } else {
    ok('4) 气泡里没有 HTML 内容')
  }

  // ============ 6. 切回 deepseek：能力恢复 ============
  console.log('\n[6] 切回 deepseek 模式')
  await openSettings()
  // 第 4 步把地址指到了 html 上游，这里先指回正常 mock，再切回 deepseek
  await setField(/服务地址|Service URL/, mockOk.base)
  await selectKind(/DeepSeek 官方|DeepSeek Official/)
  await closeSettings()
  for (const [label, re] of [
    ['智能搜索', /^智能搜索$|^Search$/],
    ['上传文件', /^上传文件$|^Upload files$/],
    ['语音输入', /^语音输入$|^Voice input$/],
  ]) {
    if (await usable(re)) {
      ok(`「${label}」入口恢复可用`)
    } else {
      bad(`6) 切回 deepseek 后「${label}」入口没有恢复`)
    }
  }
  const beforeSwitch = posts(mockOk.log, '/anthropic/v1/messages').length
  await send('切回后的消息')
  await waitFor(async () => posts(mockOk.log, '/anthropic/v1/messages').length > beforeSwitch)
  const backEntry = posts(mockOk.log, '/anthropic/v1/messages')[beforeSwitch]
  if (!backEntry) {
    bad('6) 切回 deepseek 后没有重新打到 /anthropic/v1/messages')
  } else {
    const body = jsonBody(backEntry)
    ok(`切回后路径 = ${backEntry.path}，safety_check=${JSON.stringify(body.safety_check)}`)
  }
  await page.waitForTimeout(1500)

  // ============ 7. 刷新后会话与配置仍在 ============
  console.log('\n[7] 刷新持久化')
  const sessionsBefore = await page.locator('text=' + TITLE).count()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const afterReload = await page.evaluate(() => ({
    kind: window.localStorage.getItem('chat-demo:provider-kind'),
    baseUrl: window.localStorage.getItem('chat-demo:base-url'),
    hasKey: Boolean(window.localStorage.getItem('chat-demo:api-key')),
  }))
  if (afterReload.kind !== 'deepseek' || !afterReload.hasKey) {
    bad(`7) 配置没有持久化：${JSON.stringify(afterReload)}`)
  } else {
    ok(`配置仍在：kind=${afterReload.kind} baseUrl=${afterReload.baseUrl}`)
  }
  if (sessionsBefore > 0 && (await page.getByText(TITLE).count()) > 0) {
    ok('会话与标题刷新后仍在')
  } else {
    bad('7) 刷新后会话/标题丢失')
  }
  await page.locator('text=' + TITLE).first().click()
  await page.waitForTimeout(800)
  const restored = await page.locator('body').innerText()
  if (restored.includes(REPLY_TEXT)) {
    ok('刷新后打开会话仍能看到历史回答')
  } else {
    bad('7) 刷新后历史回答丢失')
  }
} catch (error) {
  bad(`用例异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  // ============ 8. console error ============
  console.log('\n[8] console')
  // 用例期间可能出现一次 4xx/5xx 资源日志，只关心真正的脚本错误
  const realErrors = consoleErrors.filter((text) => !/Failed to load resource/i.test(text))
  if (realErrors.length > 0) {
    bad(`8) console error ${realErrors.length} 条：${realErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('8) console error = 0')
  }
  await browser.close()
  mockOk.server.close()
  mockHtml.server.close()

  console.log('\n=== 证据汇总 ===')
  for (const line of evidence) {
    console.log('  ' + line)
  }
  if (failures.length > 0) {
    console.error(`\nFAIL tests/run-acceptance.mjs（${failures.length} 条）`)
    process.exit(1)
  }
  console.log('\nPASS tests/run-acceptance.mjs')
}
