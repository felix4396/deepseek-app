// 特征测试（Golden Master）录制脚本：用法 node record.mjs --url <URL> --out <DIR> --label <NAME>
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const URL_ = arg('url', 'http://100.113.135.55:5181')
const OUT = arg('out', '/tmp/cdtest/out')
const LABEL = arg('label', 'unlabeled')
const LEGACY_KEY = 'sk-legacy-regression-placeholder'
fs.mkdirSync(OUT, { recursive: true })

/* ---------------- 通用工具 ---------------- */

// 站点内注入：类名 hash 归一化 + DOM 结构摘要
const digestFn = () => {
  const norm = (c) => c.replace(/-_?[0-9a-f]{5,6}\b/g, '')
  const skip = new Set(['SCRIPT', 'LINK', 'META', 'STYLE', 'NOSCRIPT'])
  const out = []
  const walk = (el, depth) => {
    if (depth > 22) return
    if (skip.has(el.tagName)) return
    const attrs = []
    for (const a of [...el.attributes].sort((x, y) => x.name.localeCompare(y.name))) {
      if (/^(id|for|aria-labelledby|aria-describedby|aria-controls)$/.test(a.name)) continue
      attrs.push(`${a.name}=${a.value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\d{13}/g, '<ts>').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-<masked>')}`)
    }
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean).map(norm).sort().join(' ')
    const kids = [...el.children]
    const text = kids.length === 0 ? el.textContent.trim().replace(/\s+/g, ' ').slice(0, 120) : ''
    out.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${cls ? ` .${cls}` : ''}${attrs.length ? ` [${attrs.join(' ')}]` : ''}>${text ? ` "${text}"` : ''}`)
    kids.forEach((k) => walk(k, depth + 1))
  }
  walk(document.body, 0)
  return out.join('\n')
}

const storageFn = () => {
  const dump = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    const raw = localStorage.getItem(k)
    const shape = (v) => {
      if (v === null) return 'null'
      let parsed
      try {
        parsed = JSON.parse(v)
      } catch {
        return /^sk-/.test(v) ? `string(len=${v.length}, masked)` : `string(len=${v.length})`
      }
      const describe = (x, d = 0) => {
        if (d > 3) return '…'
        if (Array.isArray(x)) return x.length ? [describe(x[0], d + 1)] : []
        if (x && typeof x === 'object') {
          const o = {}
          for (const key of Object.keys(x).sort()) {
            const val = x[key]
            if (typeof val === 'string' && /^sk-/.test(val)) o[key] = `string(len=${val.length}, masked)`
            else o[key] = describe(val, d + 1)
          }
          return o
        }
        return typeof x
      }
      return describe(parsed)
    }
    dump[k] = shape(raw)
  }
  return dump
}

const storageReport = () =>
  storageFn.call(null)

const STATES = () => {
  const q = (re) => [...document.querySelectorAll('*')].filter((e) => [...e.classList].some((c) => re.test(c)))
  const msgs = q(/^message-[\w]+$/).length
  const bubbles = q(/^bubble-[\w]+$/).length
  const send = q(/^sendButton-[\w]+$/)[0]
  const textarea = document.querySelector('textarea')
  const modal = q(/^overlay-[\w]+$/).length
  const notices = q(/^notice-[\w]+$/).map((e) => e.innerText.trim())
  return {
    messageCount: msgs,
    bubbleCount: bubbles,
    hasTextarea: !!textarea,
    textareaDisabled: textarea ? textarea.disabled : null,
    sendButtonPresent: !!send,
    sendDisabled: send ? send.disabled : null,
    modalOpen: modal > 0,
    noticeTexts: notices,
    bodyTextHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  }
}

const installHooks = async (page, rec) => {
  await page.addInitScript(() => {
    window.__consoleErrors = []
    const push = (t) => window.__consoleErrors.push(String(t).slice(0, 300))
    const origError = console.error.bind(console)
    console.error = (...a) => {
      push(a.map((x) => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
      origError(...a)
    }
    window.addEventListener('error', (e) => push(`pageerror: ${e.message}`))
    window.addEventListener('unhandledrejection', (e) => push(`unhandledrejection: ${e.reason}`))
  })
  page.on('console', (m) => {
    if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => rec.pageErrors.push(String(e.message).slice(0, 300)))
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.origin === new URL(URL_).origin) return
    const headers = req.headers()
    const entry = {
      method: req.method(),
      origin: u.origin,
      path: u.pathname,
      query: u.search ? Object.keys(Object.fromEntries(u.searchParams)) : [],
      headerNames: Object.keys(headers).sort(),
      contentType: headers['content-type'] ?? '',
    }
    const body = req.postData() ?? (() => {
      try {
        const buf = req.postDataBuffer()
        return buf ? buf.toString('utf8') : null
      } catch {
        return null
      }
    })()
    if (body && (headers['content-type'] ?? '').includes('json')) {
      try {
        const parsed = JSON.parse(body)
        entry.bodyTopLevelFields = Object.keys(parsed).sort()
        entry.bodyDetail = {
          stream: parsed.stream,
          model: parsed.model,
          messageRoles: Array.isArray(parsed.messages) ? parsed.messages.map((m) => m.role) : undefined,
          toolTypes: Array.isArray(parsed.tools) ? parsed.tools.map((t) => t.type ?? t.name) : undefined,
          safetyCheckLevel: parsed.safety_check?.level,
          systemIsArray: Array.isArray(parsed.system),
          thinkingType: parsed.thinking?.type,
          titleEnabled: parsed.title?.enabled,
        }
      } catch {
        entry.bodyParseFailed = body.slice(0, 120)
      }
    } else if (body) {
      entry.multipartFieldNames = [...body.matchAll(/name="([^"]+)"/g)].map((m) => m[1])
    }
    rec.requests.push(entry)
  })
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (u.origin === new URL(URL_).origin) return
    rec.responses.push({ method: res.request().method(), path: u.pathname, status: res.status(), contentType: res.headers()['content-type'] ?? '' })
  })
}

const newCtx = async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  return ctx
}

const seedStorage = async (ctx, entries) => {
  await ctx.addInitScript((kv) => {
    for (const [k, v] of Object.entries(kv)) {
      try {
        localStorage.setItem(k, v)
      } catch {}
    }
  }, entries)
}

const seedSession = (page, rounds) =>
  page.evaluate(async (n) => {
    const open = (name, v) =>
      new Promise((res, rej) => {
        const r = v ? indexedDB.open(name, v) : indexedDB.open(name)
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
    const db = await open('chat-demo', 11)
    const now = 1700000000000
    const messages = []
    for (let i = 0; i < n; i++) {
      messages.push({
        id: `u-${i}`,
        role: 'user',
        content: `问题 ${i}`,
        files: [],
        createdAt: now + i * 2000,
        parentId: i === 0 ? null : `a-${i - 1}`,
        selectedChildId: `a-${i}`,
      })
      messages.push({
        id: `a-${i}`,
        role: 'assistant',
        createdAt: now + i * 2000 + 1000,
        model: 'deepseek-flash',
        prefix: false,
        status: 'done',
        blocks: [{ type: 'text', text: `回答 ${i} ` + '填充文本'.repeat(20) }],
        parentId: `u-${i}`,
        ...(i < n - 1 ? { selectedChildId: `u-${i + 1}` } : {}),
      })
    }
    const session = { id: 'seed-session', title: '回归测试会话', createdAt: now, updatedAt: now + n * 2000, rootMessageId: 'u-0', messages }
    await new Promise((res, rej) => {
      const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, fileIds: [] })
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    db.close()
  }, rounds)

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false })
}

const capture = async (page, key, rec) => {
  const digest = await page.evaluate(digestFn)
  const states = await page.evaluate(STATES)
  const storage = await page.evaluate(storageFn)
  rec.captures[key] = { digest, states, storage }
  return { digest, states, storage }
}

/* ---------------- 场景 ---------------- */

const run = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const report = { label: LABEL, url: URL_, at: new Date().toISOString(), scenarios: {} }
  const scenario = (name) => {
    const rec = { consoleErrors: [], pageErrors: [], requests: [], responses: [], captures: {}, steps: [] }
    report.scenarios[name] = rec
    return rec
  }

  // S1 首页（全新，无任何 localStorage）
  {
    const rec = scenario('S1_home_fresh')
    const ctx = await newCtx(browser)
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.waitForTimeout(600)
    await capture(page, 'loaded', rec)
    await shot(page, 'S1_home_fresh')
    await ctx.close()
  }

  // S2 设置页（带旧 key，两个分组）
  {
    const rec = scenario('S2_settings')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.getByRole('button', { name: '设置' }).last().click()
    await page.waitForTimeout(600)
    await capture(page, 'general', rec)
    await shot(page, 'S2_settings_general')
    // 按可见文案切换分组，避免新增分组后下标漂移
    const dataTab = page.getByRole('tab', { name: '数据管理' })
    if (await dataTab.count()) {
      await dataTab.first().click()
      await page.waitForTimeout(400)
      await capture(page, 'data', rec)
      await shot(page, 'S2_settings_data')
    }
    const providerTab = page.getByRole('tab', { name: '模型服务' })
    if (await providerTab.count()) {
      await providerTab.first().click()
      await page.waitForTimeout(400)
      await capture(page, 'provider', rec)
      await shot(page, 'S2_settings_provider')
    }
    await ctx.close()
  }

  // S3 会话视图（20 轮）
  {
    const rec = scenario('S3_session')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await seedSession(page, 20)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.waitForTimeout(500)
    await capture(page, 'drawer', rec)
    await shot(page, 'S3_drawer')
    const t0 = Date.now()
    await page.locator('.item-ff6fc9').first().click()
    await page.waitForFunction(
      () => [...document.querySelectorAll('*')].filter((e) => [...e.classList].some((c) => /^message-[\w]+$/.test(c))).length >= 20,
      null,
      { timeout: 30000 }
    )
    rec.steps.push({ step: 'openSession', ms: Date.now() - t0 })
    await page.waitForTimeout(400)
    await capture(page, 'session', rec)
    await shot(page, 'S3_session')
    // 滚动到底部耗时
    const scroll = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('*')].filter((e) => [...e.classList].some((c) => /^message-[\w]+$/.test(c)))
      let el = nodes[0]?.parentElement
      while (el && el.scrollHeight <= el.clientHeight + 8) el = el.parentElement
      if (!el) return null
      el.scrollTop = 0
      const before = performance.now()
      el.scrollTop = el.scrollHeight
      void el.offsetHeight
      const after = performance.now()
      return { scrollMs: Math.round(after - before), scrollHeight: el.scrollHeight, messages: nodes.length }
    })
    rec.steps.push({ step: 'scrollToBottom', ...scroll })
    await ctx.close()
  }

  // S4 发送链路：新建会话 → 输入 → 发送 → 停止（使用官方默认上游 + 假 key，稳定 401）
  {
    const rec = scenario('S4_compose_send')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.locator('textarea').fill('你好')
    await page.waitForTimeout(200)
    await capture(page, 'typed', rec)
    await shot(page, 'S4_typed')
    const sendBtn = page.locator('button').filter({ has: page.locator('svg') })
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /sendButton/.test(b.className))
      el.click()
    })
    await page.waitForTimeout(400)
    await capture(page, 'afterSend400ms', rec)
    await shot(page, 'S4_after_send')
    // 等待错误提示出现（最多 15s）
    await page
      .waitForFunction(
        () => [...document.querySelectorAll('*')].some((e) => /^notice-[\w]+$/.test([...e.classList][0] ?? '')),
        null,
        { timeout: 15000 }
      )
      .catch(() => {})
    await page.waitForTimeout(1000)
    await capture(page, 'settled', rec)
    await shot(page, 'S4_settled')
    void sendBtn
    await ctx.close()
  }

  // S5 无 key 时点发送
  {
    const rec = scenario('S5_no_key_send')
    const ctx = await newCtx(browser)
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.waitForTimeout(400)
    await capture(page, 'onLoad', rec)
    // 设置弹窗自动打开时先关掉，再尝试发送
    const closers = await page.locator('[class*="close-"]').all()
    for (const c of closers) {
      if (await c.isVisible().catch(() => false)) {
        await c.click().catch(() => {})
        break
      }
    }
    await page.waitForTimeout(300)
    await page.locator('textarea').fill('你好').catch(() => {})
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /sendButton/.test(b.className))
      if (el) el.click()
    })
    await page.waitForTimeout(800)
    await capture(page, 'afterSend', rec)
    await shot(page, 'S5_no_key')
    await ctx.close()
  }

  // S6 断网
  {
    const rec = scenario('S6_offline')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await ctx.setOffline(true)
    await page.locator('textarea').fill('你好')
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /sendButton/.test(b.className))
      if (el) el.click()
    })
    await page.waitForTimeout(3000)
    await capture(page, 'settled', rec)
    await shot(page, 'S6_offline')
    await ctx.close()
  }

  // S7 附件上传 + 深度思考 + 标题生成（官方默认上游，假 key → 401，只看请求形态）
  {
    const rec = scenario('S7_upload_thinking_title')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    // 打开深度思考
    await page.getByRole('button', { name: '深度思考' }).first().click()
    await page.waitForTimeout(200)
    await capture(page, 'thinkingOn', rec)
    // 附加一个文本文件，触发 Files API 上传
    await page.setInputFiles('input[type="file"]', {
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('回归测试附件内容'),
    })
    await page.waitForTimeout(2500)
    await capture(page, 'afterUpload', rec)
    await shot(page, 'S7_after_upload')
    await ctx.close()
  }

  // S8 深度思考 + 标题生成：只发一条纯文本，检查 thinking 与 title 字段
  {
    const rec = scenario('S8_thinking_title')
    const ctx = await newCtx(browser)
    await seedStorage(ctx, { 'chat-demo:api-key': LEGACY_KEY, 'chat-demo:locale': 'zh-CN' })
    const page = await ctx.newPage()
    await installHooks(page, rec)
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForSelector('textarea', { timeout: 20000 })
    await page.getByRole('button', { name: '深度思考' }).first().click()
    await page.waitForTimeout(200)
    await capture(page, 'thinkingOn', rec)
    await page.locator('textarea').fill('你好')
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('button')].find((b) => /sendButton/.test(b.className))
      if (el) el.click()
    })
    await page.waitForTimeout(3000)
    await capture(page, 'afterSend', rec)
    await shot(page, 'S8_after_send')
    await ctx.close()
  }

  await browser.close()

  // 落盘
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1))
  // 便于人工比对的顶层摘要
  const brief = {}
  for (const [name, rec] of Object.entries(report.scenarios)) {
    brief[name] = {
      consoleErrors: rec.consoleErrors,
      pageErrors: rec.pageErrors,
      requests: rec.requests.map((r) => `${r.method} ${new URL(r.origin).host}${r.path}`),
      statuses: rec.responses.map((r) => `${r.method} ${r.path} -> ${r.status}`),
      states: Object.fromEntries(Object.entries(rec.captures).map(([k, v]) => [k, v.states])),
      steps: rec.steps,
    }
  }
  fs.writeFileSync(path.join(OUT, 'brief.json'), JSON.stringify(brief, null, 1))
  console.log(JSON.stringify(brief, null, 1))
}

await run()
