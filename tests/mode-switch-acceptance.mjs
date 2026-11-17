// 模式切换控件的自建验收：402×874 截图 + getComputedStyle 断言 + 3 次切换 + 回归（输入/按钮/发消息）。
//
//   cd /root/deepseek-app && node tests/mode-switch-acceptance.mjs
//
// 内测构建把上游钉死在 http://123.207.199.196:60010（/v1/models、/v1/messages），
// 这里用 Playwright 路由拦截本地 mock，不依赖任何真实网络。
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5181'
const UPSTREAM_HOST = '123.207.199.196'
const REPLY_TEXT = '模式切换验收回复，逐字流出。'
const OUT_DIR = 'docs/ui'

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

const sseBody = (text) => {
  const pieces = [text.slice(0, 6), text.slice(6, 14), text.slice(14)]
  const lines = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mode_accept',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'deepseek-v4.1-flash',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}`,
    '',
  ]
  for (const piece of pieces.filter(Boolean)) {
    lines.push(
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece },
      })}`,
      ''
    )
  }
  lines.push(
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20 },
    })}`,
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  )
  return lines.join('\n')
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'x-api-key,content-type,anthropic-version,authorization',
  'access-control-max-age': '600',
}

/** 读取某个分段按钮的实际计算样式 */
const readSegment = (page, mode) =>
  page.evaluate((m) => {
    const button = document.querySelector(`button[data-mode="${m}"]`)
    if (!button) {
      return null
    }
    const style = getComputedStyle(button)
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      fontWeight: style.fontWeight,
      ariaPressed: button.getAttribute('aria-pressed'),
      rect: button.getBoundingClientRect().toJSON(),
    }
  }, mode)

const SELECTED_BG = 'rgb(232, 237, 255)' // #E8EDFF
const SELECTED_FG = 'rgb(77, 107, 254)' // #4D6BFE
const DEFAULT_FG = 'rgb(23, 23, 27)' // #17171b
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

const assertState = async (page, label, selected) => {
  const fast = await readSegment(page, 'fast')
  const expert = await readSegment(page, 'expert')
  const pairs = [
    ['fast', fast, selected === 'fast'],
    ['expert', expert, selected === 'expert'],
  ]
  for (const [name, snap, isSelected] of pairs) {
    if (!snap) {
      bad(`${label}：找不到 ${name} 分段按钮`)
      continue
    }
    expect(
      snap.ariaPressed === String(isSelected),
      `${label}：${name} aria-pressed = ${isSelected}`,
      snap.ariaPressed
    )
    if (isSelected) {
      expect(
        snap.backgroundColor === SELECTED_BG && snap.color === SELECTED_FG,
        `${label}：${name} 选中态背景/文字为 #E8EDFF / #4D6BFE`,
        `bg=${snap.backgroundColor} color=${snap.color} weight=${snap.fontWeight}`
      )
    } else {
      expect(
        snap.backgroundColor === TRANSPARENT && snap.color === DEFAULT_FG,
        `${label}：${name} 未选中态背景透明 / 文字 #17171b`,
        `bg=${snap.backgroundColor} color=${snap.color} weight=${snap.fontWeight}`
      )
    }
  }
  return { fast, expert }
}

mkdirSync(OUT_DIR, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 402, height: 874 },
  colorScheme: 'light',
  deviceScaleFactor: 1,
})

const consoleErrors = []
context.on('page', (page) => {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
})

const upstreamLog = []
await context.route('**/*', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  if (url.hostname !== UPSTREAM_HOST) {
    await route.fallback()
    return
  }
  upstreamLog.push(`${request.method()} ${url.pathname}`)
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: CORS, body: '' })
    return
  }
  if (url.pathname.endsWith('/models')) {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', object: 'model' }] }),
    })
    return
  }
  if (url.pathname.endsWith('/messages')) {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: sseBody(REPLY_TEXT),
    })
    return
  }
  await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{}' })
})

const page = await context.newPage()
await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
await page.evaluate(() => window.localStorage.clear())
await page.evaluate(() => window.localStorage.setItem('chat-demo:api-key', 'sk-mode-accept-0001'))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.getByRole('button', { name: /快速模式|Fast mode/ }).waitFor({ timeout: 15000 })

console.log('\n[1] 默认态（快速模式选中）')
const layout = await page.evaluate(() => {
  const group = document.querySelector('[role="group"][aria-label]')
  const fast = document.querySelector('button[data-mode="fast"]')
  const greeting = [...document.querySelectorAll('div')].find(
    (node) =>
      node.children.length === 0 &&
      /今天有什么可以帮到你|How can I help you/.test(node.textContent || '')
  )
  const groupRect = group.getBoundingClientRect()
  const fastRect = fast.getBoundingClientRect()
  const greetingRect = greeting.getBoundingClientRect()
  const trackStyle = getComputedStyle(group)
  return {
    viewportWidth: window.innerWidth,
    groupWidth: Math.round(groupRect.width),
    groupHeight: Math.round(groupRect.height),
    groupLeft: Math.round(groupRect.left),
    groupRight: Math.round(groupRect.right),
    trackBg: trackStyle.backgroundColor,
    trackRadius: trackStyle.borderRadius,
    trackPadding: trackStyle.padding,
    greetingBottom: Math.round(greetingRect.bottom),
    groupTop: Math.round(groupRect.top),
    segmentEqualWidth: Math.round(fastRect.width * 2) === Math.round(groupRect.width - 8),
  }
})
expect(
  layout.groupWidth >= 270 && layout.groupWidth <= 280,
  `外层胶囊宽度 ${layout.groupWidth}px 落在 270–280px（402 宽下 68%）`
)
expect(
  Math.abs(layout.groupLeft - (layout.viewportWidth - layout.groupRight)) <= 1,
  '胶囊水平居中'
)
expect(layout.groupHeight >= 40 && layout.groupHeight <= 42, `胶囊高度 ${layout.groupHeight}px 在 40–42px`)
expect(layout.trackBg === 'rgb(242, 242, 245)', `轨道底色 #F2F2F5`, layout.trackBg)
expect(layout.trackPadding === '4px', `轨道内边距 4px`, layout.trackPadding)
expect(layout.segmentEqualWidth, '两段等宽')
expect(
  layout.groupTop - layout.greetingBottom >= 0 && layout.groupTop - layout.greetingBottom <= 20,
  `控件紧贴问候语正下方（问候语底 ${layout.greetingBottom}px → 控件顶 ${layout.groupTop}px）`
)

const initial = await assertState(page, '默认态', 'fast')
await page.screenshot({ path: `${OUT_DIR}/mode-01-fast.png` })
ok(`截图 ${OUT_DIR}/mode-01-fast.png`)

console.log('\n[2] 点击「专家模式」后')
await page.getByRole('button', { name: /专家模式|Expert mode/ }).click()
await wait(220)
const afterClick = await assertState(page, '点击后', 'expert')
await page.screenshot({ path: `${OUT_DIR}/mode-02-expert.png` })
ok(`截图 ${OUT_DIR}/mode-02-expert.png`)

console.log('\n[3] 连续切换 3 次')
const sequence = [
  ['fast', 'fast'],
  ['expert', 'expert'],
  ['fast', 'fast'],
]
let toggleOk = true
for (const [clicked, expected] of sequence) {
  await page.getByRole(`button`, { name: clicked === 'fast' ? /快速模式|Fast mode/ : /专家模式|Expert mode/ }).click()
  await wait(220)
  const fast = await readSegment(page, 'fast')
  const expert = await readSegment(page, 'expert')
  const selected = fast.ariaPressed === 'true' ? 'fast' : 'expert'
  const consistent =
    selected === expected &&
    (expected === 'fast'
      ? fast.backgroundColor === SELECTED_BG && expert.backgroundColor === TRANSPARENT
      : expert.backgroundColor === SELECTED_BG && fast.backgroundColor === TRANSPARENT)
  if (!consistent) {
    toggleOk = false
  }
  console.log(
    `  ·   点击 ${clicked} → 选中 ${selected}（fast bg=${fast.backgroundColor} / expert bg=${expert.backgroundColor}）`
  )
}
expect(toggleOk, '3 次切换后选中态与计算样式始终一致')

const storage = await page.evaluate(() => Object.keys(window.localStorage).sort())
expect(
  storage.every((key) => key === 'chat-demo:api-key'),
  '控件没有写入 localStorage（只剩预先种下的 api-key）',
  storage.join(',')
)

console.log('\n[4] 回归：输入框 / 深度思考 / 智能搜索 / 发消息')
const textarea = page.locator('textarea').first()
await textarea.click()
await textarea.fill('')
await textarea.type('模式切换回归：发一条消息')
expect((await textarea.inputValue()) === '模式切换回归：发一条消息', '输入框可正常输入')
const modeAfterTyping = await readSegment(page, 'fast')
expect(modeAfterTyping.ariaPressed === 'true', '输入文字不影响模式选中态（仍为快速模式）')

const thinkButton = page.getByRole('button', { name: /深度思考|DeepThink|Thinking/ }).first()
expect(await thinkButton.isVisible(), '深度思考按钮仍在')
// 内测包钉死 anthropic spec（caps.search=false），智能搜索入口本来就不渲染；
// 「智能搜索仍在」由正式包的对比回归（tests/mode-switch-plain-regression.mjs）证明。
const searchCount = await page.getByRole('button', { name: /智能搜索|Search/ }).count()
console.log(
  `  ·   智能搜索入口 count=${searchCount}（内测包 anthropic spec caps.search=false，与改动前一致；正式包已验证存在）`
)
await thinkButton.click()
await wait(120)
const thinkPressed = await thinkButton.getAttribute('aria-pressed')
await thinkButton.click()
await wait(120)
expect(thinkPressed === 'true', '深度思考按钮仍可切换（点击后 aria-pressed=true）', thinkPressed)

await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()
const reply = page.getByText(REPLY_TEXT, { exact: false }).first()
await reply.waitFor({ timeout: 20000 })
expect(await reply.isVisible(), '发消息流程正常：mock 上游回复已渲染')
expect(upstreamLog.some((entry) => entry.endsWith('/v1/messages')), '请求按原协议打到 /v1/messages', upstreamLog.join(' | '))

expect(consoleErrors.length === 0, 'console error = 0', consoleErrors.join(' | '))

await browser.close()

console.log('\n=== 汇总 ===')
console.log(
  `默认态 fast: bg=${initial.fast.backgroundColor} color=${initial.fast.color} / expert: bg=${initial.expert.backgroundColor} color=${initial.expert.color}`
)
console.log(
  `点击后 fast: bg=${afterClick.fast.backgroundColor} color=${afterClick.fast.color} / expert: bg=${afterClick.expert.backgroundColor} color=${afterClick.expert.color}`
)
if (failures.length === 0) {
  console.log('全部断言通过 ✅')
  process.exit(0)
}
console.error(`\n${failures.length} 条断言失败 ❌`)
process.exit(1)
