// [layer: integration | host Chromium + local bridge fixture; no device or external service]
// Candidate-native observability contract; virtual time is NOT Android timeout evidence.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const server = await serveDist(process.env.DIST_DIR || path.join(root, 'dist'))
const browser = await chromium.launch()
const signed = 'https://fixture.invalid/archive.zip?Signature=FAKE_SIGNATURE&AccessKeyId=FAKE_ACCESS&token=FAKE_TOKEN'
const fakeKey = 'sk-fixture-only-01234567890123456789'
let checks = 0
const check = (value, label) => { assert.ok(value, label); checks++; console.log(`ok ${checks} ${label}`) }
async function scenario(mode) {
  const context = await browser.newContext({ locale: 'zh-CN' })
  await context.route('**/*', route => new URL(route.request().url()).origin === server.url ? route.continue() : route.abort())
  await context.addInitScript(({ mode, fakeKey }) => {
    window.androidBridge = { postMessage() {} }
    window.__requests = []
    window.Capacitor = {
      PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'get', rtype: 'promise' }] }],
      nativePromise: (plugin, method, options) => {
        if (plugin !== 'CapacitorHttp' || method !== 'get') return Promise.resolve({})
        window.__requests.push({ ...options, at: Date.now() })
        if (mode === 'hang') return new Promise(() => {})
        if (mode === 'timeout') return new Promise((resolve, reject) => setTimeout(() => reject(new Error(`timeout ${options.url} Bearer ${fakeKey}`)), options.connectTimeout + options.readTimeout))
        // A native response is enough: invalid ZIP avoids needing any user archive.
        return Promise.resolve({ status: 200, headers: { 'Content-Length': '4' }, data: 'AAAAAA==', url: options.url })
      },
    }
  }, { mode, fakeKey })
  const page = await context.newPage()
  await page.goto(`${server.url}/?diag-debug=1`)
  await page.waitForFunction(() => Boolean(window.__diagnostics))
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.getByLabel('从链接导入').first().fill(signed)
  await page.getByRole('button', { name: /^导入$/ }).first().click()
  await page.clock.install()
  await page.getByRole('button', { name: /^确认导入$/ }).first().click()
  await page.waitForFunction(() => window.__requests.length === 1)
  const read = () => page.evaluate(() => {
    const snapshot = window.__diagnostics.getDiagnosticsSnapshot()
    const logs = snapshot.logs.filter(e => e.kind.startsWith('import_'))
    const payload = { ...snapshot, logs, client: { sessionId: 'fixture', clientId: 'fixture' } }
    return { logs, requests: window.__requests, json: JSON.stringify(payload), legacy: window.__diagnostics.buildLegacyLog(payload).log }
  })
  return { context, page, read }
}
try {
  {
    const { context, page, read } = await scenario('response')
    const result = await read()
    for (const msg of ['import: native request begin', 'import: native response']) {
      const entry = result.logs.find(e => e.msg === msg)
      check(entry?.meta['request.from'] === 0 && entry.meta['request.span'] === 4096 && entry.meta.attempt === 0, `${msg}: range/attempt captured`)
      check(result.legacy.includes(msg) && result.legacy.includes('"request.span":4096'), `${msg}: serialized in legacy log`)
    }
    check(result.logs.find(e => e.msg === 'import: native response')?.meta['http.status'] === 200, 'response status serialized')
    const req = result.requests[0]
    check(req.connectTimeout === 10000 && req.readTimeout === 12000 && req.headers.Range === 'bytes=0-4095', 'native options: 10s connect / 12s read / first 4KB')
    await page.clock.runFor(16000)
    check(!(await read()).logs.some(e => e.msg === 'import: native request silent >15s'), 'resolved request clears watchdog timer')
    await context.close()
  }
  {
    const { context, page, read } = await scenario('timeout')
    await page.clock.runFor(15001)
    let result = await read()
    check(result.logs.some(e => e.msg === 'import: native request silent >15s' && e.meta.elapsedMs >= 15000), '15s watchdog fires before first timeout')
    await page.clock.runFor(7000)
    result = await read()
    check(result.logs.filter(e => e.msg === 'import: native request error').length === 1, 'first modeled timeout at 22s')
    await page.clock.runFor(300)
    result = await read()
    check(result.requests.length === 2 && result.requests[1].headers.Range === 'bytes=0-2047', 'retry after 300ms with half-sized 2KB range')
    check(result.requests[1].at - result.requests[0].at === 22300, 'retry starts exactly 22.3s on fixture clock')
    await page.clock.runFor(22000)
    result = await read()
    check(result.logs.filter(e => e.msg === 'import: native request error').length === 2, 'two native error events')
    check(result.logs.filter(e => e.msg === 'import: native request silent >15s').length === 2, 'one watchdog per attempt, not recurring heartbeat')
    const terminal = result.logs.at(-1)
    check(terminal.kind === 'import_error' && terminal.meta.reason === 'timeout' && terminal.meta.durationMs >= 44300, 'modeled terminal timeout at 44.3s')
    for (const text of [result.json, result.legacy]) {
      check(!['FAKE_SIGNATURE', 'FAKE_ACCESS', 'FAKE_TOKEN', fakeKey].some(secret => text.includes(secret)), 'snapshot/legacy redacts synthetic credentials')
      check(text.includes('import: native request error') && text.includes('import: native request silent >15s'), 'error and watchdog survive serialization')
    }
    console.log(`TIMEOUT_LAST_EVENT ${JSON.stringify(terminal)}`)
    await context.close()
  }
  {
    const { context, page, read } = await scenario('hang')
    await page.clock.runFor(120000)
    const result = await read()
    check(result.requests.length === 1, 'unresolved native promise: no retry even at 120s')
    check(!result.logs.some(e => e.kind === 'import_error'), 'unresolved native promise: no terminal timeout')
    const last = result.logs.at(-1)
    check(last.msg === 'import: native request silent >15s' && last.meta.elapsedMs === 15000, '120s last import event remains the one-shot 15s watchdog')
    console.log(`HANG_LAST_EVENT ${JSON.stringify(last)}`)
    await context.close()
  }
  console.log(`PASS ${checks} assertions; host bridge fixture only; Android timeout upper bound not established`)
} finally {
  await browser.close()
  await server.close()
}
