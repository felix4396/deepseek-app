// [layer: integration | 依赖: playwright + chromium + 本地静态服务/mock 上游 | 耗时: 1~3 分钟] 说明见 tests/README.md
// 1.4.0-beta.1 内测版验收（自建、可自动化，不依赖真实上游）：
//
//   cd /root/deepseek-app && node tests/integration/internal-build.test.mjs
//
// 被测页面是**内测构建**（INTERNAL_BUILD=1）：服务地址 / 模型 / 服务类型由
// src/services/api/internalBuild.ts 的常量钉死，设置页不渲染这三项的编辑入口。
//
// 前置：把固定上游 IP 绑到本机回环，让请求真的打到 mock（见 tests/README.md）：
//   ip addr add 123.207.199.196/32 dev lo
//
// 断言（对应任务书 7 条验收）：
//   [A] 设置页 DOM：没有 Service URL 输入框、没有 Model 输入框、没有服务类型下拉、没有位置信息项
//   [B] 设置页 DOM：有 API Key 输入框（且是设置页里唯一的输入框）
//   [C] 发消息请求 URL === http://123.207.199.196:60010/v1/messages，body.model === deepseek-v4.1-flash
//   [D] 请求体不含 safety_check / title / tools，messages 里没有 role:'latest_reminder'
//   [E] 固定项不落 localStorage（只写 chat-demo:api-key）
//   [F] console error = 0
//   [G] 截图：设置页（只剩 API Key）+ 发消息后的 mock 回复
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const PORT = process.env.PORT || '5291'
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}`
const API_URL = 'http://123.207.199.196:60010'
const MESSAGES_URL = `${API_URL}/v1/messages`
const MODEL = 'deepseek-v4.1-flash'
const KEY = 'sk-internal-acceptance-key'
const REPLY = '内测版验收回复：固定服务地址与模型已生效。'
const LOG = '/tmp/mock-anthropic-requests.jsonl'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

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

const children = []
const start = (command, args, env = {}) => {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}
const waitForLine = (child, needle, timeoutMs = 10000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待「${needle}」超时`)), timeoutMs)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes(needle)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`子进程提前退出 code=${code}`))
    })
  })

const cleanup = () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
}

// ---------- 0) 起 mock 上游 + 静态服务 ----------
const mock = start('node', [path.join(ROOT, 'tests/fixtures/mock-anthropic.mjs')], { MOCK_REPLY_TEXT: REPLY })
await waitForLine(mock, 'mock anthropic upstream').catch((error) => {
  bad(`mock 上游没起来：${error.message}（是否忘了 ip addr add 123.207.199.196/32 dev lo？）`)
})
const staticServer = start('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIST])
await new Promise((resolve) => setTimeout(resolve, 800))

const browser = await chromium.launch()
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
})
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text())
  }
})
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

const shot = async (name) => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `1.4.0-beta.1-${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  note(`截图 ${path.relative(ROOT, file)}`)
}

try {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  // ---------- [A][B] 设置页 DOM ----------
  console.log('\n[A][B] 设置页 DOM')
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(400)
  const dialog = page.getByRole('dialog').first()

  const inputs = dialog.locator('input')
  const inputTypes = await inputs.evaluateAll((list) => list.map((item) => item.type))
  note(`设置页输入框：${JSON.stringify(inputTypes)}`)

  // Service URL / Model 输入框：按 aria-label 与 input 类型双重确认
  const baseUrlInputs =
    (await dialog.getByLabel(/服务地址|Service URL/).count()) +
    (await dialog.locator('input[inputmode="url"]').count())
  if (baseUrlInputs > 0) {
    bad('设置页仍然存在 Service URL 输入框')
  } else {
    ok('没有 Service URL 输入框')
  }
  const modelInputs = await dialog.getByLabel(/^模型$|^Model$/).count()
  if (modelInputs > 0) {
    bad('设置页仍然存在 Model 输入框')
  } else {
    ok('没有 Model 输入框')
  }

  // 服务类型下拉
  const kindButtons = await dialog.getByRole('button', { name: /服务类型|Service type/ }).count()
  const kindComboboxes = await dialog.getByRole('combobox', { name: /服务类型|Service type/ }).count()
  if (kindButtons + kindComboboxes > 0) {
    bad('设置页仍然存在服务类型下拉')
  } else {
    ok('没有服务类型下拉')
  }

  // API Key 输入框必须还在（且是唯一的输入框）
  const passwordInputs = await dialog.locator('input[type="password"]').count()
  if (passwordInputs !== 1) {
    bad(`API Key 输入框数量异常：${passwordInputs}（期望 1）`)
  } else {
    ok('存在 API Key 输入框（type=password）')
  }
  // type=file 是「导入历史 / 聊天背景」用的隐藏文件选择器，不是文本可编辑入口
  const extraInputs = inputTypes.filter((type) => type !== 'password' && type !== 'file')
  if (extraInputs.length > 0) {
    bad(`设置页还有其他可编辑输入框：${JSON.stringify(inputTypes)}`)
  } else {
    ok('设置页唯一可编辑的输入框是 API Key（其余仅隐藏 file 选择器）')
  }

  // 主截图：数据管理分组＝服务配置区，现在只剩 API Key
  await shot('settings-apikey')

  // 位置信息：切到「通用」分组再确认一次（整段 UI 已移除）
  await page.getByRole('tab', { name: /通用|General/ }).first().click()
  await page.waitForTimeout(300)
  const generalText = await dialog.innerText()
  const locationHits = [/位置信息/, /所在地/, /省份/, /^Location$/m, /Province/].filter((re) =>
    re.test(generalText)
  )
  if (locationHits.length > 0) {
    bad(`通用设置里仍有位置信息相关文案：${locationHits.map(String).join(' / ')}`)
  } else {
    ok('通用设置里没有位置信息项')
  }
  await shot('settings-general')

  // ---------- 保存 API Key（唯一可编辑项） ----------
  console.log('\n[E] 保存 API Key + localStorage')
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(300)
  await page.locator('input[type="password"]').first().fill(KEY)
  await page.getByRole('button', { name: /^确定$|^Confirm$/ }).first().click()
  await page.waitForTimeout(1200)

  const stored = await page.evaluate(() => {
    const out = {}
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      out[key] = window.localStorage.getItem(key)
    }
    return out
  })
  note(`localStorage: ${JSON.stringify(stored)}`)
  if (stored['chat-demo:api-key'] !== KEY) {
    bad('API Key 没有写入 localStorage')
  } else {
    ok('API Key 已保存')
  }
  for (const forbidden of ['chat-demo:base-url', 'chat-demo:model', 'chat-demo:provider-kind']) {
    if (Object.hasOwn(stored, forbidden)) {
      bad(`固定项被写进了 localStorage：${forbidden}=${stored[forbidden]}`)
    }
  }
  if (!['chat-demo:base-url', 'chat-demo:model', 'chat-demo:provider-kind'].some((key) => Object.hasOwn(stored, key))) {
    ok('地址 / 模型 / 服务类型没有落 localStorage')
  }

  // 关掉设置
  await dialog.getByRole('button', { name: /^关闭$|^Close$/ }).first().click()
  await page.waitForTimeout(400)

  // ---------- 发消息 ----------
  console.log('\n[C][D] 发消息：URL / model / 请求体')
  const textarea = page.locator('textarea').last()
  await textarea.click()
  await textarea.fill('你好，内测版')
  await page.getByRole('button', { name: /^发送$|^Send$/ }).first().click()

  await page.getByText(REPLY.slice(0, 10)).first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(1200)
  ok('mock 回复已渲染到消息列表')
  await shot('reply')

  const log = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const posts = log.filter((entry) => entry.method === 'POST' && entry.path.startsWith('/v1/messages'))
  note(`mock 收到请求：${log.map((entry) => `${entry.method} ${entry.url}`).join(' , ') || '（无）'}`)

  if (posts.length === 0) {
    bad(`mock 没有收到发消息请求（期望 ${MESSAGES_URL}）`)
  } else {
    const hit = posts[0]
    if (hit.url !== MESSAGES_URL) {
      bad(`发消息 URL 不是固定地址：${hit.url}`)
    } else {
      ok(`发消息 URL = ${hit.url}`)
    }
    let body = {}
    try {
      body = JSON.parse(hit.body)
    } catch {
      bad('请求体不是 JSON')
    }
    if (body.model !== MODEL) {
      bad(`body.model 不是固定模型：${JSON.stringify(body.model)}`)
    } else {
      ok(`body.model = ${body.model}`)
    }
    if (hit.headers['x-api-key'] !== KEY) {
      bad(`x-api-key 头不对：${JSON.stringify(hit.headers['x-api-key'])}`)
    } else {
      ok('x-api-key = 用户填的 key')
    }
    if (hit.headers['anthropic-version']) {
      bad(`不该带 anthropic-version（中转 CORS 预检会失败）：${hit.headers['anthropic-version']}`)
    } else {
      ok('未带 anthropic-version')
    }

    const topLevel = Object.keys(body)
    note(`请求体顶层字段 = ${JSON.stringify(topLevel)}`)
    for (const field of ['safety_check', 'title', 'tools']) {
      if (Object.hasOwn(body, field)) {
        bad(`请求体仍带 ${field}`)
      } else {
        ok(`已剥离 ${field}`)
      }
    }
    const roles = (body.messages ?? []).map((message) => message.role)
    if (roles.includes('latest_reminder')) {
      bad("请求体 messages 里仍有 role:'latest_reminder'")
    } else {
      ok("messages 里没有 role:'latest_reminder'")
    }
    const system = String(body.system ?? '')
    if (!system.includes('Web')) {
      bad(`提醒内容没有折进 system：${JSON.stringify(system)}`)
    } else if (/,,\s/.test(system)) {
      bad(`system 里出现空段（位置信息移除后遗留的空逗号）：${JSON.stringify(system)}`)
    } else {
      ok(`提醒内容已折进 system，无空段（${system.length} 字符）`)
    }
  }

  // ---------- [F] console error ----------
  console.log('\n[F] console error')
  if (consoleErrors.length > 0) {
    bad(`console 有 ${consoleErrors.length} 条 error：${consoleErrors.slice(0, 3).join(' | ')}`)
  } else {
    ok('console error = 0')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  cleanup()
}

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} tests/integration/internal-build.test.mjs`)
if (evidence.length > 0) {
  console.log('证据：')
  for (const item of evidence) {
    console.log(`  · ${item}`)
  }
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`)
  }
  process.exit(1)
}
