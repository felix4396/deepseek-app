// Issue #28 补充：IndexedDB 半写入 / 数据损坏时，主界面与打开会话的表现
// 目的：确认「没有错误边界」时，一个渲染期异常是否 = 全屏空白（用户描述的「白屏」）
import http from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildArchive } from '../tests/fixtures/archive-fixture.mjs'
import { mkdirSync } from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 对照用：DIST_DIR 指向被测包（修复前 = 637adfb 的标准包，修复后 = 本分支的标准包）
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'repro')
const PORT = Number(process.env.PORT || 5221)
const APP_URL = `http://127.0.0.1:${PORT}/`
const KEY = 'sk-repro-0123456789abcdef'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, APP_URL)
  let file = path.join(DIST, decodeURIComponent(url.pathname))
  if (url.pathname === '/') file = path.join(DIST, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

mkdirSync(OUT_DIR, { recursive: true })
const ZIP = buildArchive({ sessionCount: 2 }).zip

const snap = (page) =>
  page.evaluate(() => {
    const text = document.body?.innerText || ''
    const root = document.getElementById('root')
    return {
      nodes: document.querySelectorAll('*').length,
      rootChildren: root?.children.length ?? -1,
      innerTextLen: text.length,
      innerTextHead: text.replace(/\s+/g, ' ').slice(0, 160),
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      textarea: document.querySelectorAll('textarea').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }
  })

// 把会话记录写坏（模拟导入中断 / 半写入 / 存储被外部改坏）
const corrupt = (page, mode) =>
  page.evaluate(async (mode) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = (store) =>
      new Promise((resolve) => {
        const all = db.transaction(store, 'readonly').objectStore(store).getAll()
        all.onsuccess = () => resolve(all.result)
        all.onerror = () => resolve([])
      })
    const sessions = await readAll('sessions')
    const first = sessions[0]
    if (!first) return { ok: false, reason: 'no session' }
    const tx = db.transaction(['sessions'], 'readwrite')
    const store = tx.objectStore('sessions')
    if (mode === 'messages-null') {
      store.put({ ...first, messages: null })
    } else if (mode === 'fragments-null') {
      store.put({ ...first, messages: first.messages.map((m) => ({ ...m, fragments: null })) })
    } else if (mode === 'files-null') {
      store.put({ ...first, messages: first.messages.map((m) => ({ ...m, files: null })) })
    } else if (mode === 'root-missing') {
      store.put({ ...first, rootMessageId: 'does-not-exist' })
    }
    await new Promise((resolve) => (tx.oncomplete = resolve))
    db.close()
    return { ok: true, id: first.id, title: first.title }
  }, mode)

const scenarios = [
  { id: 'v1-messages-null', mode: 'messages-null' },
  { id: 'v2-fragments-null', mode: 'fragments-null' },
  { id: 'v3-files-null', mode: 'files-null' },
  { id: 'v4-root-missing', mode: 'root-missing' },
]

const browser = await chromium.launch()
const reports = []
for (const scenario of scenarios) {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  const logs = { pageErrors: [], consoleErrors: [] }
  page.on('pageerror', (e) => logs.pageErrors.push(`${e.name}: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && logs.consoleErrors.push(m.text()))
  await page.route('**/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] }),
    })
  )
  const report = { id: scenario.id, steps: [] }
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
    await page.evaluate(async () => {
      localStorage.clear()
      for (const info of await indexedDB.databases())
        if (info.name) indexedDB.deleteDatabase(info.name)
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    if ((await page.getByRole('dialog').count()) === 0) {
      await page
        .getByRole('button', { name: /设置|Settings/ })
        .last()
        .click()
      await page.waitForTimeout(300)
    }
    await page
      .getByRole('tab', { name: /数据管理|Data/ })
      .first()
      .click()
    await page.locator('input[type="password"]').first().fill(KEY)
    await page
      .getByRole('button', { name: /^确定$/ })
      .last()
      .click()
    await page.waitForTimeout(700)
    await page.setInputFiles('input[type="file"][accept*="zip"]', {
      name: 'd.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(ZIP),
    })
    await page.waitForTimeout(400)
    await page
      .getByRole('button', { name: /确认导入/ })
      .last()
      .click()
    await page
      .waitForFunction(() => !/正在导入|正在解析/.test(document.body.innerText), undefined, {
        timeout: 30000,
      })
      .catch(() => {})
    await page.waitForTimeout(600)
    await page
      .locator('[role="dialog"]')
      .first()
      .getByRole('button', { name: /关闭|Close/ })
      .first()
      .click()
    await page.waitForTimeout(900)
    report.steps.push({ step: 'baseline', snap: await snap(page) })

    report.corrupt = await corrupt(page, scenario.mode)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    report.steps.push({ step: 'after-corrupt-reload', snap: await snap(page) })

    const title = report.corrupt?.title ?? '链接导入测试会话'
    const item = page.getByText(title, { exact: true }).first()
    await item.click({ timeout: 4000 }).catch((e) => (report.clickError = String(e).slice(0, 150)))
    await page.waitForTimeout(1500)
    report.steps.push({ step: 'open-corrupt-session', snap: await snap(page) })
    report.shot = path.join(OUT_DIR, `shot-${scenario.id}.png`)
    await page.screenshot({ path: report.shot }).catch(() => {})
  } catch (error) {
    report.harnessError = String(error).slice(0, 250)
  }
  report.pageErrors = logs.pageErrors
  report.consoleErrors = logs.consoleErrors
  await context.close()
  reports.push(report)
  const last = report.steps.at(-1)?.snap
  console.log(
    `\n=== ${report.id}  corrupt=${JSON.stringify(report.corrupt)}\n` +
      `  last(${report.steps.at(-1)?.step}): nodes=${last?.nodes} rootChildren=${last?.rootChildren} text=${last?.innerTextLen} textarea=${last?.textarea}\n` +
      `  head: ${last?.innerTextHead}\n` +
      `  pageErrors=${report.pageErrors.length}: ${report.pageErrors.slice(0, 2).join(' | ')}\n` +
      `  consoleErrors=${report.consoleErrors.length}: ${report.consoleErrors.slice(0, 3).join(' | ')}` +
      (report.harnessError ? `\n  harnessError: ${report.harnessError}` : '')
  )
}
await browser.close()
server.close()
const out = path.join(OUT_DIR, `corrupt-${Date.now()}.json`)
await writeFile(out, JSON.stringify(reports, null, 2))
console.log(`\nreport → ${out}`)
