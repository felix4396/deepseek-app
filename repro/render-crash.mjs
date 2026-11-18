// Issue #28 对照（错误边界）：把一条会话的标题写成对象 → React 渲染对象子节点必抛。
// 同一份脚本跑两个包，比较「修复前 = 整屏纯白」与「修复后 = 可读错误页」。
//
//   DIST_DIR=<包目录> OUT_DIR=<截图与报告目录> node repro/render-crash.mjs
//
// 修复前包：637adfb 的标准包（#28 复现用的同一个 dist，main.6cd0093a.js）
// 修复后包：本分支标准包（含全局 ErrorBoundary）
import http from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildArchive } from '../tests/fixtures/archive-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist')
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'repro')
const PORT = Number(process.env.PORT || 5222)
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

mkdirSync(OUT_DIR, { recursive: true })

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
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve))

const ZIP = buildArchive({ sessionCount: 2 }).zip

const snap = (page) =>
  page.evaluate(() => {
    const text = document.body?.innerText || ''
    const root = document.getElementById('root')
    return {
      nodes: document.querySelectorAll('*').length,
      rootChildren: root?.children.length ?? -1,
      innerTextLen: text.trim().length,
      innerTextHead: text.replace(/\s+/g, ' ').trim().slice(0, 160),
      errorPage: document.querySelectorAll('[data-testid="error-boundary"]').length,
      buttons: Array.from(document.querySelectorAll('[data-testid^="error-boundary-"]')).map((el) =>
        (el.textContent || '').trim()
      ),
    }
  })

const browser = await chromium.launch()
// 桌面视口：侧栏列表会渲染会话标题（移动端的列表在抽屉里，不展开就碰不到这条数据）
const context = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 900 },
})
const page = await context.newPage()
const pageErrors = []
const consoleErrors = []
page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`))
page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()))
await page.route('**/models', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }] }),
  })
)

const report = { dist: DIST, steps: [] }
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
  const keyInput = page.locator('input[type="password"]').first()
  if (await keyInput.count()) {
    await keyInput.fill(KEY)
    await page
      .getByRole('button', { name: /^确定$/ })
      .last()
      .click()
    await page.waitForTimeout(700)
  }
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
  await page.waitForFunction(() => !/正在导入|正在解析/.test(document.body.innerText), undefined, {
    timeout: 30000,
  })
  await page.waitForTimeout(600)
  await page
    .locator('[role="dialog"]')
    .first()
    .getByRole('button', { name: /关闭|Close/ })
    .first()
    .click()
  await page.waitForTimeout(900)

  // 把首条会话的标题写成对象（sessions 决定正文标题，sessionSummaries 决定侧栏标题）
  report.corrupt = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('chat-demo')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readAll = (store) =>
      new Promise((resolve) => {
        const query = db.transaction(store, 'readonly').objectStore(store).getAll()
        query.onsuccess = () => resolve(query.result)
        query.onerror = () => resolve([])
      })
    const sessions = (await readAll('sessions')).sort((a, b) => a.createdAt - b.createdAt)
    const first = sessions[0]
    if (!first) return { ok: false, reason: 'no session' }
    const stores = ['sessions', 'sessionSummaries'].filter((name) =>
      db.objectStoreNames.contains(name)
    )
    const tx = db.transaction(stores, 'readwrite')
    tx.objectStore('sessions').put({ ...first, title: { broken: true } })
    if (db.objectStoreNames.contains('sessionSummaries')) {
      tx.objectStore('sessionSummaries').put({ id: first.id, title: { broken: true } })
    }
    await new Promise((resolve) => (tx.oncomplete = resolve))
    db.close()
    return { ok: true, id: first.id }
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  report.steps.push({ step: 'after-reload', snap: await snap(page) })
  report.shot = path.join(OUT_DIR, 'shot-render-crash-390.png')
  await page.screenshot({ path: report.shot })
  await page.setViewportSize({ width: 360, height: 780 })
  await page.waitForTimeout(400)
  report.shot360 = path.join(OUT_DIR, 'shot-render-crash-360.png')
  await page.screenshot({ path: report.shot360 })
} catch (error) {
  report.harnessError = String(error).slice(0, 300)
}
report.pageErrors = pageErrors
report.consoleErrors = consoleErrors.slice(0, 3)
await browser.close()
server.close()
const out = path.join(OUT_DIR, 'render-crash.json')
writeFileSync(out, JSON.stringify(report, null, 2))
const last = report.steps.at(-1)?.snap
console.log(
  `\ndist=${report.dist}\n` +
    `  last: nodes=${last?.nodes} rootChildren=${last?.rootChildren} text=${last?.innerTextLen} errorPage=${last?.errorPage}\n` +
    `  head: ${last?.innerTextHead}\n` +
    `  errorPageButtons: ${JSON.stringify(last?.buttons)}\n` +
    `  pageErrors=${report.pageErrors.length}: ${report.pageErrors.slice(0, 1).join('')}\n` +
    `  consoleErrors=${report.consoleErrors.length}: ${report.consoleErrors.slice(0, 1).join('').slice(0, 160)}\n` +
    `  shots: ${report.shot} ${report.shot360}` +
    (report.harnessError ? `\n  harnessError: ${report.harnessError}` : '')
)
