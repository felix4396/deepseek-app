// [layer: device | 依赖: 已启动的模拟器 + adb + 我们的渠道测试 Key]
// 「我们的渠道 → 额度与卡密 → 查询额度」真机验证（Issue #10 追加项）。
//
//   KEY=$(cat /root/.secrets/ours-test-key) node tests/device/ours-balance-device.mjs --api 33
//
// 安全约束（硬性）：
//   * Key 只从文件读，只填进 App 的 API Key 输入框；不打印、不写日志、不写报告、不进 URL。
//   * 报告里只出现尾 6 位掩码；截图前确认页面上没有完整 Key（保存后 UI 本身是 **** 掩码）。
//   * 只点「查询额度」，绝不点任何提交/发送类按钮。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const ADB = process.env.ADB || '/root/android-sdk/platform-tools/adb'
const SERIAL = process.env.SERIAL || 'emulator-5554'
const PACKAGE = 'com.example.deepseekchat'
const CDP_PORT = Number(process.env.CDP_PORT || 9232)
const OUT_DIR = new URL('../../docs/compat/', import.meta.url).pathname
const SHOT_DIR = `${OUT_DIR}shots/`

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const API = String(arg('api', '33'))
const KEY = readFileSync('/root/.secrets/ours-test-key', 'utf8').trim()
const KEY_TAIL = KEY.slice(-6)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8' }).trim()
const shQuiet = (...a) => {
  try {
    return sh(...a)
  } catch {
    return ''
  }
}

const checks = []
const record = (name, status, detail) => {
  checks.push({ name, status, detail })
  const mark = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '·'
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((res, rej) => {
    socket.onopen = res
    socket.onerror = (e) => rej(new Error(String(e?.message)))
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data)
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      return
    }
    for (const l of listeners) l(m)
  }
  const send = (method, params = {}, timeoutMs = 60_000) =>
    new Promise((res, rej) => {
      id += 1
      const myId = id
      pending.set(myId, { res, rej })
      socket.send(JSON.stringify({ id: myId, method, params }))
      setTimeout(() => {
        if (pending.has(myId)) {
          pending.delete(myId)
          rej(new Error(`CDP ${method} 超时`))
        }
      }, timeoutMs)
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
    return r.result.value
  }
  return { socket, send, evaluate, listeners }
}

const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true })
  const pid = shQuiet('shell', 'pidof', PACKAGE)
  if (!pid) throw new Error('App 未运行，先启动 App')
  shQuiet('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const target = list.find((t) => t.type === 'page')
  if (!target) throw new Error('拿不到 devtools target')
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  const consoleErrors = []
  cdp.listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? ''}`)
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.reload')
  await sleep(6000)

  // 桥级记录：CapacitorHttp 的请求参数（只记录，照常放行 —— 这里要的就是真实请求）
  const bridge = await cdp.evaluate(`(() => {
    if (!window.Capacitor || typeof window.Capacitor.nativePromise !== 'function') return 'no-nativePromise'
    if (window.__oursProbe) return 'already'
    const orig = window.Capacitor.nativePromise.bind(window.Capacitor)
    window.__oursProbe = { calls: [] }
    window.Capacitor.nativePromise = async (plugin, method, options) => {
      if (plugin === 'CapacitorHttp') {
        const rec = { method, url: options && options.url, headers: (options && options.headers) || null,
          apiKeyInQuery: /api_?key=|key=/i.test(String(options && options.url)), status: null, body: null }
        window.__oursProbe.calls.push(rec)
        const result = await orig(plugin, method, options)
        rec.status = result && result.status
        rec.body = typeof (result && result.data) === 'string' ? result.data.slice(0, 400) : null
        return result
      }
      return orig(plugin, method, options)
    }
    return 'ok'
  })()`)
  record('注入 CapacitorHttp 桥探针（只观测，不改请求）', bridge === 'ok' || bridge === 'already' ? 'pass' : 'fail', String(bridge))

  const click = (names) =>
    cdp.evaluate(`(() => {
      const wanted = ${JSON.stringify(names)}
      const nodes = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"]')]
      const el = nodes.find((n) => wanted.includes((n.textContent || '').trim()))
      if (!el) return 'not-found: ' + nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).slice(0, 16).join('|')
      el.click(); return 'ok'
    })()`)

  // 1) 设置 → General → 填 API Key
  // 已配置 Key 的 App 处于「侧栏 + 聊天」布局：设置入口在侧栏抽屉里，先展开侧栏
  const drawer = await cdp.evaluate(`(() => {
    const el = document.querySelector('[aria-label="Open sidebar"],[aria-label="打开侧栏"]')
    if (!el) return 'no-drawer-btn'
    el.click(); return 'opened'
  })()`)
  await sleep(1200)
  let opened = await click(['设置', 'Settings'])
  if (opened !== 'ok') {
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[aria-label="设置"],[aria-label="Settings"],[data-testid="settings"]')
      if (el) { el.click(); return 'ok-aria' }
      return 'not-found'
    })()`).then((r) => { opened = r })
  }
  record('打开设置', opened === 'ok' || opened === 'ok-aria' ? 'pass' : 'fail', `侧栏=${drawer} 结果=${opened}`)
  await sleep(1500)
  // beta.8 布局：设置只有 General / Data 两个 tab，API Key 与「额度与卡密」都在 **Data** 页
  record('切到 Data/数据管理（beta.8 把渠道与 Key 放在这一页）', (await click(['数据管理', 'Data'])) === 'ok' ? 'pass' : 'fail')
  await sleep(800)
  const filled = await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input[type="password"]')
    if (!input) return 'no-password-input'
    const shadowForm = document.querySelector('[role="dialog"] input[placeholder*="API"]')
    const target = input || shadowForm
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(target, ${JSON.stringify(KEY)})
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.focus()
    return 'ok:len=' + target.value.length
  })()`)
  record('填入 API Key（长度不回显内容）', String(filled).startsWith('ok') ? 'pass' : 'fail', String(filled))
  // 确认按钮（t('confirm')）
  let confirmed = await click(['确定', 'Confirm', 'OK', '保存', 'Save'])
  if (confirmed !== 'ok') {
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[role="dialog"] input[type="password"]')
      if (!input) return 'no-input'
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
      input.blur()
      return 'enter'
    })()`)
    confirmed = 'enter/blur'
  }
  await sleep(2000)
  const saved = await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const pwd = dialog ? dialog.querySelector('input[type="password"]') : null
    const text = dialog ? dialog.innerText : ''
    return {
      passwordInputGone: !pwd,
      masked: /\\*{6,}/.test(text) || /\\*{6,}/.test(dialog ? dialog.innerHTML : ''),
      tailShown: ${JSON.stringify(KEY_TAIL)} && (text.includes(${JSON.stringify(KEY_TAIL)}) ? 'yes' : 'no'),
      hasFullKeyInDom: (dialog ? dialog.innerHTML : '').includes(${JSON.stringify(KEY)}) || (pwd ? pwd.value === ${JSON.stringify(KEY)} : false),
    }
  })()`)
  record(
    'Key 保存后 UI 用掩码显示（明文不落在文本节点里）',
    saved.visualMasked && !saved.fullKeyInTextNodes ? 'pass' : 'fail',
    JSON.stringify(saved)
  )
  // 编辑态输入框里仍留着刚填的值：截图前清空（值已在 store 里，清空输入框不影响已保存的 Key）
  await cdp.evaluate(`(() => {
    const input = document.querySelector('[role="dialog"] input[type="password"]')
    if (!input) return 'none'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.blur()
    return 'cleared'
  })()`)
  await sleep(600)

  // 2) 同一页里找「额度与卡密」的打开按钮
  const openRow = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
    const el = nodes.find((n) => /^(打开|Open)$/.test((n.textContent || '').trim()))
    if (!el) return 'not-found:' + nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).slice(0, 16).join('|')
    el.click(); return 'ok'
  })()`)
  await sleep(1500)
  const dialogOpen = await cdp.evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    return { open: !!top, text: top ? top.innerText.slice(0, 300) : '', buttons: top ? [...top.querySelectorAll('button')].map((b) => b.textContent.trim()) : [] }
  })()`)
  record('打开「额度与卡密」弹窗', dialogOpen.open && /额度|Quota/i.test(dialogOpen.text) ? 'pass' : 'fail', `row=${openRow} 按钮=${JSON.stringify(dialogOpen.buttons)}`)

  // 3) 查询额度
  const clicked = await click(['查询额度', 'Check quota'])
  record('点击「查询额度」', clicked === 'ok' ? 'pass' : 'fail', String(clicked))
  let result = null
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    result = await cdp.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const top = dialogs[dialogs.length - 1]
      const text = top ? top.innerText : ''
      return { text: text.slice(0, 500), loading: /查询中|Checking/.test(text), calls: (window.__oursProbe && window.__oursProbe.calls || []).map((c) => ({ url: c.url, status: c.status, method: c.method, hasAuth: !!(c.headers && (c.headers.Authorization || c.headers.authorization)), keyInQuery: c.apiKeyInQuery, body: c.body })) }
    })()`)
    if (result?.calls?.some((c) => c.status !== null) && !result.loading) break
    await sleep(800)
  }
  const call = (result?.calls || []).find((c) => String(c.url || '').includes('balance'))
  const text = result?.text || ''
  const masked = `…${KEY_TAIL}`
  record('请求走 /api/balance 且 URL 无 query', Boolean(call) && !String(call.url).includes('?'), call ? `${call.method} ${String(call.url).replace(/^http:\/\/[^/]+/, '')}` : '未捕获到请求')
  record('请求用 Authorization: Bearer（Key 不进 URL/不进日志）', Boolean(call?.hasAuth) && call?.keyInQuery === false, `hasAuth=${call?.hasAuth} keyInQuery=${call?.keyInQuery}`)
  record('后端返回 200', call?.status === 200, `status=${call?.status}`)
  record('余额与后端一致（当前 0）', /(^|\D)0(\D|$)/.test(String(call?.body || '')) || /(额度为 0|quota is 0)/i.test(text), `body=${String(call?.body || '').slice(0, 120)}`)
  record('UI 显示「未查询到该 Key 的兑换额度（或额度为 0）」类文案', /(暂未查询到该 Key 的兑换额度|No redeemed quota found)/i.test(text), text.replace(/\n/g, ' / ').slice(0, 200))
  record('UI 显示 Key 掩码（尾 6 位）', text.includes(KEY_TAIL), `tail=${KEY_TAIL} 命中=${text.includes(KEY_TAIL)}`)
  record('未出现「额度不足 / 报错」类文案', !/(额度不足|余额不足|insufficient|error|失败)/i.test(text), '')
  record('无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // 4) 截图（确保页面无完整 Key）
  const domHasKey = await cdp.evaluate(`document.documentElement.innerHTML.includes(${JSON.stringify(KEY)})`)
  record('截图前确认整页 DOM 无完整 Key', domHasKey === false, `hasFullKey=${domHasKey}`)
  let shotFile = null
  try {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, 120_000)
    shotFile = `${SHOT_DIR}${API}-balance.png`
    writeFileSync(shotFile, Buffer.from(image.data, 'base64'))
    console.log(`     截图 ${shotFile}`)
  } catch (error) {
    record('额度截图', 'fail', String(error.message).slice(0, 120))
  }

  const report = {
    api: Number(API),
    generatedAt: new Date().toISOString(),
    keyMask: `…${KEY_TAIL}`,
    keySource: '/root/.secrets/ours-test-key（只读，内容不入报告）',
    request: call ? { method: call.method, urlPath: String(call.url).replace(/^http:\/\/[^/]+/, ''), hasQuery: String(call.url).includes('?'), hasAuthorizationHeader: call.hasAuth, status: call.status, bodyHead: String(call.body || '').slice(0, 200) } : null,
    uiText: text.slice(0, 400),
    consoleErrors,
    checks,
    screenshot: shotFile,
    verdict: checks.every((c) => c.status !== 'fail') ? 'pass' : 'fail',
  }
  writeFileSync(`${OUT_DIR}${API}-balance.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n[report] ${OUT_DIR}${API}-balance.json`)
  console.log(`[verdict] ${report.verdict}`)
  cdp.socket.close()
  if (report.verdict !== 'pass') process.exitCode = 1
}

await run()
