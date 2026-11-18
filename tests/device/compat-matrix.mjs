// [layer: device | 依赖: 已启动的 Android 模拟器 + adb | 耗时: 3~10 分钟/台]
// 兼容性矩阵：同一组检查跑在不同 API 级别的 AOSP google_apis x86_64 镜像上。
//
// 运行（每台 AVD 串行，先 tests/device/avd-boot.sh compat30 再跑本脚本）：
//   node tests/device/compat-matrix.mjs --api 30 --avd compat30
//   node tests/device/compat-matrix.mjs --api 33 --avd compat33 --serial emulator-5554
//
// 产出：docs/compat/<api>.json（机器可读报告）+ docs/compat/shots/<api>-*.png（关键截图）
//
// 硬性约定（父代理决策，勿改）：
//   * 触摸滑动一律用真实触摸注入（CDP Input.dispatchTouchEvent，失败回落 adb input swipe），
//     绝不用 scrollTop 赋值伪造「能滚」。
//   * 软键盘：无头模拟器不弹真软键盘，键盘遮挡用 visualViewport 收缩模拟，
//     报告里必须标 simulated=true，不得写成「真机键盘已验证」。
//   * 「旧内核」的事实依据只认设备侧真值（getprop + dumpsys webviewupdate + 原生插件快照），
//     UA 只作为交叉校验，不用 UA 猜结论。
//   * AOSP 通过 ≠ ColorOS/OEM 真机通过；OEM 输入法、window inset 一律列真机待验项。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildArchive } from '../fixtures/archive-fixture.mjs'

const ADB = process.env.ADB || '/root/android-sdk/platform-tools/adb'
const PACKAGE = 'com.example.deepseekchat'
const APK =
  process.env.APK ||
  new URL('../../android/app/build/outputs/apk/debug/app-debug.apk', import.meta.url).pathname
const OUT_DIR = new URL('../../docs/compat/', import.meta.url).pathname
const SHOT_DIR = `${OUT_DIR}shots/`

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const API = String(arg('api', process.env.API || '30'))
const AVD = arg('avd', process.env.AVD || `compat${API}`)
const SERIAL = arg('serial', process.env.SERIAL || 'emulator-5554')
const PORT = Number(arg('port', process.env.ARCHIVE_PORT || 5231))
const SKIP_INSTALL = arg('skip-install', '') === '1'
const CDP_PORT = Number(arg('cdp-port', 9230))

const ZIP_URL = `http://10.0.2.2:${PORT}/deepseek_data.zip`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── adb ──────────────────────────────────────────────────────────────────────
const sh = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim()
const shRaw = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' })
const shQuiet = (...args) => {
  try {
    return sh(...args)
  } catch {
    return ''
  }
}

// ── 报告骨架 ─────────────────────────────────────────────────────────────────
const checks = []
const shots = []
const consoleErrors = []
const record = (group, name, status, detail = '', evidence = undefined) => {
  const normalized = typeof status === 'boolean' ? (status ? 'pass' : 'fail') : status
  const entry = { group, name, status: normalized, detail, ...(evidence ? { evidence } : {}) }
  checks.push(entry)
  const mark = normalized === 'pass' ? '✓' : normalized === 'fail' ? '✗' : '·'
  console.log(`  ${mark} [${group}] ${name}${detail ? ` — ${detail}` : ''}`)
  return normalized === 'pass'
}
const pass = (g, n, ok, detail, ev) => record(g, n, ok ? 'pass' : 'fail', detail, ev)
const skip = (g, n, detail) => record(g, n, 'skip', detail)

// ── 极简 CDP（Node 自带 WebSocket；Playwright 高层 CDP 不支持 WebView 的
//    Browser.setDownloadBehavior，已有前例，所以这里只用页面级协议）────────────
const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`))
  })
  let nextId = 0
  const pending = new Map()
  const listeners = []
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
      return
    }
    for (const l of listeners) l(msg)
  }
  const send = (method, params = {}, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      nextId += 1
      const id = nextId
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
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
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return r.result.value
  }
  return { socket, send, evaluate, listeners }
}

const shot = async (cdp, name) => {
  try {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }, 120_000)
    const file = `${SHOT_DIR}${API}-${name}.png`
    writeFileSync(file, Buffer.from(image.data, 'base64'))
    shots.push(file)
    console.log(`     截图 ${file}`)
    return file
  } catch (error) {
    console.log(`     [warn] 截图 ${name} 失败（不中断）: ${String(error.message).slice(0, 120)}`)
    return null
  }
}

const waitForText = async (cdp, texts, timeoutMs = 12_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await cdp
      .evaluate(
        `(${JSON.stringify(texts)}).some((t) => document.body.innerText.includes(t))`
      )
      .catch(() => false)
    if (found) return true
    await sleep(300)
  }
  return false
}

/** 按钮文案中英通吃，点不到时返回候选文案便于定位 */
const clickButton = async (cdp, names) =>
  cdp.evaluate(`(() => {
    const wanted = ${JSON.stringify(Array.isArray(names) ? names : [names])}
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"],a[role="button"]')]
    const target = nodes.find((el) => wanted.includes(el.textContent.trim()))
    if (!target) return 'not-found: ' + nodes.map((el) => el.textContent.trim()).filter(Boolean).join('|').slice(0, 300)
    target.click()
    return 'ok'
  })()`)

/** 指针/触摸事件计数器：证明触摸真的打到了页面（不是 scrollTop 赋值） */
const installTouchTap = (cdp) =>
  cdp.evaluate(`(() => {
    window.__compatTouch = { start: 0, move: 0, end: 0 }
    const bump = (key) => () => { window.__compatTouch[key] += 1 }
    document.addEventListener('touchstart', bump('start'), { passive: true, capture: true })
    document.addEventListener('touchmove', bump('move'), { passive: true, capture: true })
    document.addEventListener('touchend', bump('end'), { passive: true, capture: true })
    return true
  })()`)

/** 在页面里找最大的可滚动盒子（弹窗内的日志预览等） */
const findScroller = (cdp, scope) =>
  cdp.evaluate(`(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document.body'}
    if (!root) return null
    const all = [root, ...root.querySelectorAll('*')]
    let best = null
    for (const el of all) {
      const over = el.scrollHeight - el.clientHeight
      if (over > 24 && el.clientHeight > 60) {
        if (!best || over > best.over) {
          const r = el.getBoundingClientRect()
          best = {
            over,
            tag: el.tagName,
            cls: (el.className || '').toString().slice(0, 60),
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          }
          el.setAttribute('data-compat-scroller', '1')
        }
      }
    }
    return best
  })()`)

const scrollerState = (cdp) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector('[data-compat-scroller]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4, atTop: el.scrollTop <= 2 }
  })()`)

/**
 * 真实触摸滑动：优先 CDP Input.dispatchTouchEvent；失败回落 adb input swipe。
 * 坐标单位是 CSS px（CDP 用 CSS px，adb 用设备 px，按 devicePixelRatio 换算）。
 */
const touchSwipe = async (cdp, { x, fromY, toY, steps = 10, ms = 320 }) => {
  const dpr = await cdp.evaluate('window.devicePixelRatio || 1')
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {})
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: fromY }],
    })
    for (let i = 1; i <= steps; i += 1) {
      const y = fromY + ((toY - fromY) * i) / steps
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      await sleep(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // 关键校验：触摸事件有没有真的进到页面。WebView 上 Input 域可能静默无效（计数仍为 0）
    const counts = await cdp.evaluate('window.__compatTouch || null').catch(() => null)
    if (counts && counts.start === 0) {
      const toDevice = (v) => Math.round(v * dpr)
      shQuiet('shell', 'input', 'swipe', String(toDevice(x)), String(toDevice(fromY)), String(toDevice(x)), String(toDevice(toY)), String(ms))
      return { via: 'adb-input-swipe(realtime-fallback: cdp-touch 未产生事件)' }
    }
    return { via: 'cdp-touch' }
  } catch (error) {
    const toDevice = (v) => Math.round(v * dpr)
    shQuiet('shell', 'input', 'swipe', String(toDevice(x)), String(toDevice(fromY)), String(toDevice(x)), String(toDevice(toY)), String(ms))
    return { via: 'adb-input-swipe', fallbackReason: String(error.message).slice(0, 120) }
  }
}

// ── 产物静态分析（构建基线 vs 内核）：白屏到底是「语法解析不了」还是「API 缺失」───────
const analyzeBundle = () => {
  const dir = new URL('../../dist/static/js/', import.meta.url).pathname
  const files = readdirSync(dir).filter((f) => f.startsWith('main.'))
  if (files.length === 0) return { error: 'dist/static/js 下没有 main.*.js' }
  const file = files[0]
  const code = readFileSync(`${dir}${file}`, 'utf8')
  const patterns = [
    ['逻辑赋值 ||= / &&= / ??=', /\|\|=|&&=|\?\?=/, 85],
    ['类静态块 static {}', /static\s*\{/, 94],
    ['私有字段 #x', /#[A-Za-z_$][\w$]*\s*[=;]/, 74],
    ['Object.hasOwn', /Object\.hasOwn/, 93],
    ['.at()', /\.at\(-?\d/, 92],
    ['.toSorted()', /\.toSorted\(/, 110],
    ['.toReversed()', /\.toReversed\(/, 110],
    ['structuredClone', /structuredClone/, 98],
    ['CSS dvh', /100dvh/, 108],
  ]
  const features = []
  for (const [name, re, needsChrome] of patterns) {
    const m = re.exec(code)
    if (m) {
      features.push({
        feature: name,
        needsChrome,
        index: m.index,
        snippet: code.slice(Math.max(0, m.index - 70), m.index + 70),
      })
    }
  }
  const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
  return { bundle: file, bytes: code.length, targets, features }
}

// ── 设备事实（结论的唯一依据）─────────────────────────────────────────────────
const deviceFacts = () => {
  const get = (prop) => shQuiet('shell', 'getprop', prop)
  const dump = shQuiet('shell', 'dumpsys', 'webviewupdate')
  const provider = /Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/.exec(dump)
  const multiprocess = /Multiprocess enabled: (\w+)/.exec(dump)
  const preferred = /Preferred WebView package \(name, version\): \(([^,]+), ([^)]+)\)/.exec(dump)
  // dumpsys webviewupdate 没有字面量 webview_implementation 字段：实现形态只能由
  // 「包名 + Multiprocess 开关 + 版本号」三件事说明，报告里保留原文避免臆造。
  const implementation = provider
    ? `${provider[1] === 'com.android.chrome' ? 'chrome-provider' : 'webview-provider'} / multiprocess=${multiprocess?.[1] ?? 'unknown'}`
    : 'unknown'
  return {
    release: get('ro.build.version.release'),
    sdk: Number(get('ro.build.version.sdk')),
    flavor: get('ro.build.flavor'),
    abi: get('ro.product.cpu.abi'),
    manufacturer: get('ro.product.manufacturer'),
    model: get('ro.product.model'),
    fontScaleSetting: shQuiet('shell', 'settings', 'get', 'system', 'font_scale') || 'null',
    webview: {
      provider: provider?.[1] ?? 'unknown',
      version: provider?.[2] ?? 'unknown',
      preferred: preferred ? `${preferred[1]} ${preferred[2]}` : 'unknown',
      implementation,
      multiprocess: multiprocess?.[1] ?? 'unknown',
      dumpRaw: dump,
    },
  }
}

const setFontScale = (value) => {
  // 复原不能用 'null'（API31 起 IllegalArgumentException: Invalid value: null），改回默认 1.0
  if (value === null) shQuiet('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
  else shQuiet('shell', 'settings', 'put', 'system', 'font_scale', String(value))
  // 不额外发 CONFIGURATION_CHANGED 广播：shell uid 无权限（SecurityException），
  // 而且本阶段本来就 force-stop + 重启 App，启动时会重新读 Configuration.fontScale。
}

const launchApp = async () => {
  shQuiet('shell', 'am', 'force-stop', PACKAGE)
  await sleep(800)
  shQuiet('shell', 'monkey', '-p', PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1')
  await sleep(4000)
  for (let i = 0; i < 30; i += 1) {
    const pid = shQuiet('shell', 'pidof', PACKAGE)
    if (pid) return pid
    await sleep(1000)
  }
  return ''
}

const attach = async (pid, { resetErrors = true } = {}) => {
  if (resetErrors) consoleErrors.length = 0
  shQuiet('forward', `tcp:${CDP_PORT}`, `localabstract:webview_devtools_remote_${pid}`)
  let target = null
  for (let i = 0; i < 30; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      // devtools socket 还没起来
    }
    await sleep(1000)
  }
  if (!target) throw new Error('拿不到 WebView devtools target')
  const cdp = await connectCdp(target.webSocketDebuggerUrl)
  cdp.listeners.push((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(`console: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      consoleErrors.push(`exception: ${d.exception?.description ?? d.text}`)
    }
  })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1200)
  return { cdp, target }
}

// ── 各阶段检查 ───────────────────────────────────────────────────────────────
const PROBE_EXPR = `(() => {
  const t = (fn) => { try { return typeof fn() } catch (e) { return 'throws:' + (e && e.name) } }
  const caps = {
    toSorted: typeof Array.prototype.toSorted,
    toReversed: typeof Array.prototype.toReversed,
    toSpliced: typeof Array.prototype.toSpliced,
    with: typeof Array.prototype.with,
    hasOwn: typeof Object.hasOwn,
    arrayAt: typeof Array.prototype.at,
    structuredClone: typeof window.structuredClone,
    fetch: typeof window.fetch,
    AbortController: typeof window.AbortController,
    ResizeObserver: typeof window.ResizeObserver,
    visualViewport: !!window.visualViewport,
    TextDecoder: typeof window.TextDecoder,
    dvh: (() => { try { return !!(window.CSS && CSS.supports('height', '100dvh')) } catch (e) { return false } })(),
  }
  const ua = navigator.userAgent
  const chrome = /Chrome\\/([\\d.]+)/.exec(ua)
  return {
    ua,
    chromeVersion: chrome ? chrome[1] : null,
    wvFlag: /\\bwv\\b/.test(ua),
    caps,
    viewport: { innerWidth: innerWidth, innerHeight: innerHeight, dpr: devicePixelRatio,
      vv: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } : null },
    uaParsed: {
      android: /Android\\s+([\\d.]+)/i.exec(ua)?.[1] ?? 'unknown',
      webview: /\\bwv\\b/.test(ua) ? (/Chrome\\/([\\d.]+)/i.exec(ua)?.[1] ?? 'unknown') : 'unknown',
    },
    // 用同一条表达式交叉验证「不动 scrollTop 也能读到值」——只做记录，不作为通过依据
    navigatorPlatform: navigator.platform,
  }
})()`

const stageProbe = async (cdp, facts) => {
  console.log(`\n[1] 能力探测（API ${API}）`)
  const probe = await cdp.evaluate(PROBE_EXPR)
  console.log(`     UA: ${probe.ua}`)
  console.log(`     内核（UA Chrome 版本）: ${probe.chromeVersion}  wv 标记: ${probe.wvFlag}`)
  console.log(`     设备侧真值: Android ${facts.release} / SDK ${facts.sdk} / WebView ${facts.webview.provider} ${facts.webview.version}`)
  // 交叉校验：UA 里的内核版本必须和 dumpsys 一致，否则说明 UA 被覆写，不能拿 UA 当结论
  const uaVersionMatchesDump = String(probe.chromeVersion || '').startsWith(
    String(facts.webview.version || '').split('.').slice(0, 2).join('.')
  )
  record(
    'capability',
    'UA 内核版本与 dumpsys 一致（UA 可用于交叉校验）',
    uaVersionMatchesDump ? 'pass' : 'fail',
    `UA=${probe.chromeVersion} / dumpsys=${facts.webview.version}`
  )
  const expectations = {
    toSorted: 110,
    toReversed: 110,
    toSpliced: 110,
    with: 110,
    hasOwn: 93,
    arrayAt: 92,
    structuredClone: 98,
    dvh: 108,
  }
  const major = Number(String(probe.chromeVersion || '0').split('.')[0])
  const capRows = {}
  for (const [key, version] of Object.entries(expectations)) {
    const actual = key === 'dvh' ? probe.caps.dvh : probe.caps[key] === 'function'
    const expected = major >= version
    capRows[key] = { available: actual, needsChrome: version, matchesExpectation: actual === expected }
    record(
      'capability',
      `${key}（需要 Chrome ${version}+）`,
      actual === expected ? 'pass' : 'fail',
      `实际=${actual}，按内核 ${major} 预期=${expected}`
    )
  }
  for (const key of ['fetch', 'AbortController', 'ResizeObserver', 'visualViewport', 'TextDecoder']) {
    capRows[key] = { available: probe.caps[key] === 'function' || probe.caps[key] === true, needsChrome: 0 }
    record('capability', `${key} 可用`, capRows[key].available === true, String(probe.caps[key]))
  }
  return { probe, capRows }
}

const stageStartup = async (cdp) => {
  console.log('\n[2] 启动 / 首屏渲染')
  // 先 reload 一次：让首次渲染的 JS 异常落在已经开启的 Runtime 监听里（否则白屏只有结果没有原因）
  await cdp.send('Page.reload').catch(() => {})
  await sleep(7000)
  const render = await cdp.evaluate(`(() => {
    const body = document.body
    const text = (body?.innerText || '').trim()
    const root = document.getElementById('root') || body.firstElementChild
    const nodes = document.querySelectorAll('*').length
    const textarea = document.querySelector('textarea')
    const bg = body ? getComputedStyle(body).backgroundColor : ''
    return {
      readyState: document.readyState,
      textLength: text.length,
      textHead: text.slice(0, 160),
      nodeCount: nodes,
      rootChildCount: root ? root.children.length : -1,
      hasTextarea: !!textarea,
      textareaPlaceholder: textarea ? textarea.placeholder : null,
      welcome: text.includes('今天有什么可以帮到你') || /how can i help you/i.test(text),
      bodyBackground: bg,
      title: document.title,
    }
  })()`)
  const whiteScreen = render.nodeCount < 8 || (render.textLength === 0 && !render.hasTextarea)
  pass(
    'startup',
    '非白屏（DOM 已渲染出内容）',
    !whiteScreen,
    `节点=${render.nodeCount} 文本长度=${render.textLength} readyState=${render.readyState} body=${render.bodyBackground}`
  )
  pass('startup', '欢迎页文案出现', render.welcome, render.textHead.replace(/\n/g, ' / ').slice(0, 120))
  pass(
    'startup',
    'ChatInput 渲染（textarea + 占位符）',
    render.hasTextarea,
    `placeholder=${render.textareaPlaceholder}`
  )
  if (whiteScreen) {
    // 白屏必须给原因：加载期异常 + 缺哪个能力时到底抛什么
    const firstError = consoleErrors.find((e) => /exception|is not a function|undefined/.test(e)) ?? ''
    record(
      'startup',
      '首屏失败原因（JS 运行时异常）',
      firstError ? 'fail' : 'skip',
      firstError ? firstError.slice(0, 300) : '加载期没有捕获到异常（可能是静默失败，见下方能力复现）'
    )
    const repro = await cdp
      .evaluate(`(() => {
        const out = {}
        try { out.hasOwn = String(Object.hasOwn({}, 'a')) } catch (e) { out.hasOwn = 'throws: ' + e.name + ': ' + e.message }
        try { out.at = String([].at(-1)) } catch (e) { out.at = 'throws: ' + e.name + ': ' + e.message }
        out.rootHtml = (document.getElementById('root') || document.body).innerHTML.slice(0, 200)
        return out
      })()`)
      .catch((e) => ({ error: String(e.message).slice(0, 160) }))
    record(
      'startup',
      '缺能力复现（应用实际会抛的错）',
      'fail',
      JSON.stringify(repro).slice(0, 300)
    )
    const logcatTail = shQuiet('logcat', '-d', '-t', '800')
    // 打包产物语法级不兼容定位：从异常里的 line/col 反查本地 dist 片段 + 构建声明的最低基线
    try {
      const haystack = [firstError, ...consoleErrors, logcatTail].join('\n')
      const m =
        /line"?\s*:\s*(\d+)\s*,\s*col"?\s*:\s*(\d+)/.exec(haystack) ??
        /line (\d+) col (\d+)/.exec(haystack)
      const target = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
      const files = (await import('node:fs')).readdirSync(
        new URL('../../dist/static/js/', import.meta.url).pathname
      )
      const main = files.find((f) => f.startsWith('main.'))
      if (m && main) {
        const code = readFileSync(
          new URL(`../../dist/static/js/${main}`, import.meta.url).pathname,
          'utf8'
        )
        const col = Number(m[2])
        record(
          'startup',
          '打包产物语法不兼容定位（构建基线 vs 内核）',
          'fail',
          `bundle=${main} 位置 ${col} 附近: …${code.slice(Math.max(0, col - 90), col + 90)}… ` +
            `| rspack targets=${JSON.stringify(target)}（Chrome 105 基线，本内核 Chrome ${probeOut?.probe?.chromeVersion ?? '?'}）`
        )
      }
    } catch (error) {
      record('startup', '打包产物语法不兼容定位', 'skip', String(error.message).slice(0, 160))
    }
    const jsLines = logcatTail
      .split('\n')
      .filter((l) => /Uncaught|TypeError|chromium/i.test(l))
      .slice(-4)
    record(
      'startup',
      'logcat/Chromium 佐证',
      jsLines.length > 0 ? 'fail' : 'skip',
      jsLines.join(' | ').slice(0, 300) || 'logcat 无 Uncaught 记录'
    )
  }
  await shot(cdp, 'startup')
  return { render, whiteScreen }
}

const openSettings = async (cdp) => {
  const opened = await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)
  if (opened) return 'ok'
  // 设置入口：先按文案点，再按 aria-label 兜底
  let result = await clickButton(cdp, ['设置', 'Settings'])
  if (result !== 'ok') {
    result = await cdp.evaluate(`(() => {
      const el = document.querySelector('[aria-label="设置"],[aria-label="Settings"],[data-testid="settings"]')
      if (!el) return 'not-found'
      el.click(); return 'ok-aria'
    })()`)
  }
  await sleep(1200)
  const isOpen = await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)
  return isOpen ? (result === 'ok' ? 'ok' : result) : result
}

const openFeedback = async (cdp) => {
  const settingsOpened = await openSettings(cdp)
  record('feedback', '打开设置弹窗', settingsOpened === 'ok' || settingsOpened === 'ok-aria', String(settingsOpened))
  if (settingsOpened !== 'ok' && settingsOpened !== 'ok-aria') return { opened: false }
  const cell = await clickButton(cdp, ['反馈与日志', 'Feedback & logs', 'Feedback', 'Send feedback'])
  await sleep(1200)
  const dialogState = await cdp.evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    if (!top) return { dialog: false }
    return {
      dialog: true,
      text: (top.innerText || '').slice(0, 400),
      hasTextarea: !!top.querySelector('textarea'),
      buttons: [...top.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean),
    }
  })()`)
  pass('feedback', '反馈弹窗打开', dialogState.dialog === true, `点击结果=${cell}`)
  return { opened: dialogState.dialog, dialogState, cellResult: cell }
}

const stageFeedback = async (cdp) => {
  console.log('\n[3] 反馈弹窗：滚动 / 保存日志 / 取消保留 / 键盘遮挡')
  const open = await openFeedback(cdp)
  if (!open.opened) {
    skip('feedback', '弹窗内滚动（首尾触摸）', '弹窗未打开，无法判定')
    skip('feedback', '保存日志按钮可达', '弹窗未打开，无法判定')
    skip('feedback', '取消后表单保留', '弹窗未打开，无法判定')
    return { opened: false }
  }
  console.log(`     弹窗按钮: ${(open.dialogState.buttons || []).join(' | ')}`)
  await installTouchTap(cdp)
  const scroller = await findScroller(cdp, '[role="dialog"]:last-of-type')
  if (!scroller) {
    skip('feedback', '弹窗内滚动（首尾触摸）', '弹窗内没有可滚动区域（内容未超出）')
  } else {
    console.log(
      `     滚动容器: ${scroller.tag}.${scroller.cls} 内容=${scroller.scrollHeight} 可视=${scroller.clientHeight} 需要滚动=${scroller.over}px`
    )
    const cx = scroller.rect.x + scroller.rect.w / 2
    const cy = scroller.rect.y + scroller.rect.h / 2
    const before = await scrollerState(cdp)
    await shot(cdp, 'feedback-top')
    const dpr = await cdp.evaluate('window.devicePixelRatio || 1')
    const adbSwipe = (fromY, toY, label) => {
      shQuiet('shell', 'input', 'swipe', String(Math.round(cx * dpr)), String(Math.round(fromY * dpr)),
        String(Math.round(cx * dpr)), String(Math.round(toY * dpr)), '320')
      return `adb-input-swipe(${label})`
    }
    // 手指上滑（内容向上滚）→ 去尾部
    let channel = 'cdp-touch'
    for (let i = 0; i < 4; i += 1) {
      const r = await touchSwipe(cdp, { x: cx, fromY: cy + 60, toY: cy - 120 })
      channel = r.via
      await sleep(260)
    }
    let afterDown = await scrollerState(cdp)
    // 若 CDP 触摸没带来滚动效果，换 adb 真触摸注入（同一时间段只有一台设备，安全）
    if ((afterDown?.scrollTop ?? 0) <= (before?.scrollTop ?? 0) + 4) {
      for (let i = 0; i < 4; i += 1) {
        channel = adbSwipe(cy + 60, cy - 120, 'down')
        await sleep(400)
      }
      afterDown = await scrollerState(cdp)
    }
    await shot(cdp, 'feedback-bottom')
    // 手指下滑（内容向下滚）→ 回顶部
    for (let i = 0; i < 5; i += 1) {
      await touchSwipe(cdp, { x: cx, fromY: cy - 120, toY: cy + 60 })
      await sleep(260)
    }
    let afterUp = await scrollerState(cdp)
    if ((afterUp?.scrollTop ?? 0) >= (afterDown?.scrollTop ?? 0) - 4 && !afterUp?.atTop) {
      for (let i = 0; i < 5; i += 1) {
        channel = adbSwipe(cy - 120, cy + 60, 'up')
        await sleep(400)
      }
      afterUp = await scrollerState(cdp)
    }
    const touchCounts = await cdp.evaluate('window.__compatTouch')
    pass(
      'feedback',
      '首部→尾部真实触摸滚动生效',
      (afterDown?.scrollTop ?? 0) > (before?.scrollTop ?? 0) + 20 && Boolean(afterDown?.atBottom),
      `${before?.scrollTop} → ${afterDown?.scrollTop}（内容 ${scroller.scrollHeight} / 可视 ${scroller.clientHeight}），触摸事件 ${JSON.stringify(touchCounts)}，通道=${channel}`
    )
    pass(
      'feedback',
      '尾部→首部真实触摸滚动生效',
      Boolean(afterUp?.atTop) && (afterUp?.scrollTop ?? 0) < (afterDown?.scrollTop ?? 0),
      `回到 scrollTop=${afterUp?.scrollTop}，通道=${channel}`
    )
  }

  // 保存日志按钮是否可达（存在 + 在视口内 + 未被禁用）
  const saveBtn = await cdp.evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    if (!top) return { found: false }
    const btn = [...top.querySelectorAll('button')].find((b) => /保存日志|Save log/i.test(b.textContent || ''))
    if (!btn) return { found: false, buttons: [...top.querySelectorAll('button')].map((b) => (b.textContent||'').trim()) }
    btn.scrollIntoView({ block: 'center' })
    const r = btn.getBoundingClientRect()
    return {
      found: true,
      disabled: btn.disabled,
      inViewport: r.top >= 0 && r.bottom <= innerHeight && r.width > 0 && r.height > 0,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) },
      innerHeight,
    }
  })()`)
  pass(
    'feedback',
    '保存日志按钮可达（可见 + 未禁用）',
    saveBtn.found && saveBtn.inViewport && !saveBtn.disabled,
    JSON.stringify(saveBtn)
  )
  await shot(cdp, 'feedback-save-button')

  // 取消后表单保留：先写入文本，取消，再打开
  const typed = await cdp.evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    const ta = top?.querySelector('textarea')
    if (!ta) return 'no-textarea'
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, 'compat-matrix 表单保留自测')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return ta.value
  })()`)
  await sleep(500)
  const cancelled = await clickButton(cdp, ['取消', 'Cancel'])
  await sleep(1000)
  const reopened = await openFeedback(cdp)
  const retained = await cdp.evaluate(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    const ta = top?.querySelector('textarea')
    return ta ? ta.value : null
  })()`)
  pass(
    'feedback',
    '取消后重新打开，表单内容保留',
    retained === 'compat-matrix 表单保留自测',
    `写入=${typed} 取消=${cancelled} 重开值=${retained}`
  )

  // 键盘遮挡：先看真软键盘是否让 visualViewport 收缩，否则用注入模拟并标注
  const kb = await cdp.evaluate(`(async () => {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')]
    const top = dialogs[dialogs.length - 1]
    const ta = top?.querySelector('textarea')
    if (!ta) return { ok: false, reason: 'no-textarea' }
    const before = { innerHeight, vv: visualViewport ? visualViewport.height : null }
    ta.focus()
    await new Promise((r) => setTimeout(r, 1200))
    const after = { innerHeight, vv: visualViewport ? visualViewport.height : null }
    return { ok: true, before, after, shrunk: visualViewport ? visualViewport.height < before.vv - 20 : innerHeight < before.innerHeight - 20 }
  })()`)
  if (kb.ok && kb.shrunk) {
    const covered = await cdp.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const top = dialogs[dialogs.length - 1]
      const btn = [...top.querySelectorAll('button')].find((b) => /提交|Submit/i.test(b.textContent || ''))
      if (!btn) return { found: false }
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      const limit = visualViewport ? visualViewport.height : innerHeight
      return { found: true, bottom: Math.round(r.bottom), limit: Math.round(limit), covered: r.bottom > limit + 1 }
    })()`)
    pass(
      'feedback',
      '软键盘弹出后提交按钮不被遮挡（真软键盘）',
      covered.found && !covered.covered,
      JSON.stringify({ ...covered, kb: kb.after })
    )
  } else {
    // 无头模拟器不弹真软键盘 → 真实做法：把 WebView 视口压矮 40%（等价键盘 inset），
    // 让页面走一次真实重排，再测提交按钮是否仍可达。仍标注 simulated（不是真 IME）。
    const vp = await cdp.evaluate('({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')
    const keyboardPx = Math.round(vp.h * 0.42)
    await cdp
      .send('Emulation.setDeviceMetricsOverride', {
        width: vp.w,
        height: vp.h - keyboardPx,
        deviceScaleFactor: vp.dpr,
        mobile: true,
      })
      .catch(() => {})
    await sleep(1200)
    const simulated = await cdp.evaluate(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')]
      const top = dialogs[dialogs.length - 1]
      const btn = [...top.querySelectorAll('button')].find((b) => /提交|Submit/i.test(b.textContent || ''))
      if (!btn) return { found: false }
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      return {
        found: true,
        viewportAfterInset: innerHeight,
        buttonTop: Math.round(r.top),
        buttonBottom: Math.round(r.bottom),
        reachable: r.top >= 0 && r.bottom <= innerHeight,
        dialogScrollable: (() => {
          const d = [...document.querySelectorAll('[role="dialog"]')].pop()
          return d ? d.scrollHeight > d.clientHeight + 4 : null
        })(),
        simulated: true,
      }
    })()`)
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    await sleep(500)
    record(
      'feedback',
      `键盘遮挡检查（视口压矮 ${keyboardPx}px 模拟键盘 inset，非真 IME）`,
      simulated.found && simulated.reachable ? 'pass' : simulated.found ? 'fail' : 'skip',
      JSON.stringify(simulated)
    )
  }
  await shot(cdp, 'feedback-keyboard')
  return { opened: true }
}

const stageImport = async (cdp, archive) => {
  console.log('\n[4] 导入入口：从链接导入（本地 mock zip，不连真实用户链接）')
  const inDialog = await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)
  if (!inDialog) {
    const opened = await openSettings(cdp)
    if (opened !== 'ok' && opened !== 'ok-aria') {
      record('import', '打开设置', 'fail', String(opened))
      skip('import', '数据管理 → 从链接导入', '设置打不开，无法判定')
      return
    }
  }
  const dataTab = await clickButton(cdp, ['数据管理', 'Data'])
  await sleep(800)
  record('import', '切到「数据管理」', dataTab === 'ok' ? 'pass' : 'fail', String(dataTab))
  const hasUrlInput = await cdp.evaluate(`!!document.querySelector('input[type="url"]')`)
  const linkBtnBefore = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
    const el = nodes.find((n) => /^导入$|^Import link$/i.test((n.textContent || '').trim()))
    return el ? { found: true, disabled: el.disabled } : { found: false }
  })()`)
  const linkBtn = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
    const el = nodes.find((n) => /^导入$|^Import link$/i.test((n.textContent || '').trim()))
    if (!el) return { found: false, buttons: nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).slice(0, 14) }
    const r = el.getBoundingClientRect()
    return { found: true, disabled: el.disabled, rect: { y: Math.round(r.y), h: Math.round(r.height) } }
  })()`)
  record(
    'import',
    '「从链接导入」入口存在（URL 为空时 disabled 属正常）',
    linkBtn.found ? 'pass' : 'fail',
    JSON.stringify({ before: linkBtnBefore, after: linkBtn })
  )
  if (!hasUrlInput) {
    skip('import', 'URL 输入框可填', '原生端未渲染 input[type=url]')
    return
  }
  const filled = await cdp.evaluate(`(() => {
    const input = document.querySelector('input[type="url"]')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(ZIP_URL)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value
  })()`)
  record('import', 'URL 输入框可填', filled === ZIP_URL, `长度 ${String(filled).length}`)
  const afterFill = await cdp.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
    const el = nodes.find((n) => /^导入$|^Import link$/i.test((n.textContent || '').trim()))
    return el ? { found: true, disabled: el.disabled } : { found: false }
  })()`)
  record('import', '填入 URL 后「导入」按钮变为可点', afterFill.found && !afterFill.disabled, JSON.stringify(afterFill))
  await shot(cdp, 'import-settings')
  const clickImport = await clickButton(cdp, ['导入', 'Import link'])
  record('import', '点「导入」按钮', clickImport === 'ok' ? 'pass' : 'fail', String(clickImport))
  const confirmShown = await waitForText(cdp, ['确认导入历史对话', 'Import chat history'], 10_000)
  record('import', '覆盖确认弹窗出现', confirmShown ? 'pass' : 'fail', '')
  if (confirmShown) {
    await clickButton(cdp, ['确认导入', 'Import'])
  }
  // 阶段事件采集：轮询页面文案变化
  const stages = []
  const deadline = Date.now() + 240_000
  let done = false
  while (Date.now() < deadline) {
    const snapshot = await cdp.evaluate(`(() => {
      const t = document.body.innerText
      return {
        downloading: /下载中|Downloading/.test(t),
        importing: /正在导入|Importing/.test(t),
        imported: /已导入\\s*\\d+\\s*个会话|Imported/.test(t),
        failed: /导入失败|失败：|failed/i.test(t),
        cancelText: /导入已取消/.test(t),
        trace: (t.match(/开始导入[\\s\\S]{0,120}/) || [''])[0].slice(0, 160),
      }
    })()`).catch(() => ({}))
    if (snapshot.downloading && !stages.includes('downloading')) stages.push('downloading')
    if (snapshot.importing && !stages.includes('importing')) stages.push('importing')
    if (snapshot.imported && !stages.includes('imported')) stages.push('imported')
    if (snapshot.failed && !stages.includes('failed')) stages.push('failed')
    if (snapshot.cancelText && !stages.includes('cancelled')) stages.push('cancelled')
    if (snapshot.imported || snapshot.failed) {
      done = true
      break
    }
    await sleep(1000)
  }
  await shot(cdp, 'import-done')
  const sessionCount = await cdp
    .evaluate(`new Promise((resolve) => {
      const request = indexedDB.open('chat-demo')
      request.onerror = () => resolve(-1)
      request.onsuccess = () => {
        const db = request.result
        if (!db.objectStoreNames.contains('sessions')) { resolve(0); return }
        const c = db.transaction('sessions', 'readonly').objectStore('sessions').count()
        c.onsuccess = () => resolve(c.result)
        c.onerror = () => resolve(-1)
      }
    })`)
    .catch(() => -1)
  pass(
    'import',
    '阶段事件走通（下载/导入 → 完成，未崩）',
    done && stages.includes('imported'),
    `阶段=${stages.join('>') || '无'} 会话数=${sessionCount}/${archive?.sessions ?? '?'}`
  )
  return { stages, sessionCount }
}

// ── 系统信息真值（Issue #5）：日志导出 / 上传 payload 里的字段必须真实且 fallback 不阻塞 ──
// 做法：在 WebView 页里拦截 Capacitor 的 nativePromise 桥与 fetch。
//   * ExportText.start/writeChunk/finish → 拦住 SAF 弹窗，直接拿到要写盘的 JSON 全文；
//   * fetch 命中 /feedback → 拦住，绝不打到真实反馈接口，同时拿到「上传 body」原文；
//   * DiagnosticsDevice.snapshot 抛错 → 复现原生插件不可用，验证 fallback 不白屏。
const installBridgeCapture = (cdp, { failDiagnostics = false } = {}) =>
  cdp.evaluate(`(() => {
    if (!window.Capacitor || typeof window.Capacitor.nativePromise !== 'function') return 'no-nativePromise'
    if (!window.__compatNativeOrig) {
      window.__compatNativeOrig = window.Capacitor.nativePromise.bind(window.Capacitor)
    }
    const orig = window.__compatNativeOrig
    window.__compatNative = { calls: [], exportText: [], uploads: [], failDiagnostics: ${failDiagnostics} }
    window.Capacitor.nativePromise = async (plugin, method, options) => {
      window.__compatNative.calls.push(plugin + '.' + method)
      if (plugin === 'DiagnosticsDevice' && method === 'snapshot' && window.__compatNative.failDiagnostics) {
        throw new Error('COMPAT_MATRIX_FORCED_FALLBACK')
      }
      if (plugin === 'ExportText') {
        if (method === 'start') { window.__compatNative.exportText = []; return { id: 'compat-matrix', status: 'ready' } }
        if (method === 'writeChunk') { window.__compatNative.exportText.push(options && options.data ? options.data : ''); return {} }
        if (method === 'finish') return { status: 'saved' }
        if (method === 'abort') return {}
      }
      return orig(plugin, method, options)
    }
    if (!window.__compatFetchPatched) {
      window.__compatFetchPatched = true
      const of = window.fetch
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (String(url).includes('/feedback') && window.__compatNative) {
          const body = init && typeof init.body === 'string' ? init.body : ''
          window.__compatNative.uploads.push({ url: String(url), bodyLength: body.length, body })
          return new Response(JSON.stringify({ ok: true, ticket: 'COMPAT-MATRIX-LOCAL-ONLY' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return of(input, init)
      }
    }
    return 'ok'
  })()`)

const readCapture = (cdp) =>
  cdp.evaluate(`(() => {
    const c = window.__compatNative
    if (!c) return { missing: true }
    const text = (c.exportText || []).join('')
    let parsed = null
    try { parsed = JSON.parse(text) } catch (e) { parsed = null }
    const up = c.uploads || []
    return {
      calls: c.calls.slice(-14),
      exportBytes: text.length,
      parsed,
      uploads: up.map((u) => ({ url: u.url, bodyLength: u.bodyLength, body: u.body.slice(0, 400000) })),
    }
  })()`)

const clickSaveLog = async (cdp) => {
  const r = await clickButton(cdp, ['保存日志文件', 'Save log file'])
  await sleep(2500)
  return r
}

const stageSystemInfo = async (cdp, facts, probeOut) => {
  console.log('\n[5] 系统信息真值：原生快照 / 导出 JSON / 上传 payload / fallback（Issue #5）')
  const systeminfo = {
    api: Number(API),
    avd: AVD,
    generatedAt: new Date().toISOString(),
    deviceTruth: {
      androidRelease: facts.release,
      androidSdk: facts.sdk,
      webviewProvider: facts.webview.provider,
      webviewVersion: facts.webview.version,
      webviewImplementation: facts.webview.implementation,
      fontScaleSetting: facts.fontScaleSetting,
      model: facts.model,
    },
    native: null,
    exportPayload: null,
    uploadPayload: null,
    fallback: null,
    fields: {},
    caveats: [],
  }

  // ── 5.1 原生插件直读 ─────────────────────────────────────────────────────
  const native = await cdp
    .evaluate(`(async () => {
      try {
        const plugin = window.Capacitor?.registerPlugin ? window.Capacitor.registerPlugin('DiagnosticsDevice') : null
        if (!plugin) return { available: false, reason: 'window.Capacitor 不可用' }
        return { available: true, snap: await plugin.snapshot() }
      } catch (error) {
        return { available: false, reason: String(error?.message ?? error).slice(0, 200) }
      }
    })()`)
    .catch((e) => ({ available: false, reason: String(e.message).slice(0, 200) }))
  systeminfo.native = native
  record('systeminfo', '原生诊断插件 DiagnosticsDevice 可调用', native.available ? 'pass' : 'fail',
    native.available ? `appSource=${native.snap?.appSource} nativePath 走 PackageManager` : native.reason)
  const settingScale = facts.fontScaleSetting === 'null' ? 1 : Number(facts.fontScaleSetting)
  if (native.available) {
    const s = native.snap
    systeminfo.fields.nativeSnapshot = {
      androidRelease: s.androidRelease, androidSdk: s.androidSdk, webviewPackage: s.webviewPackage,
      webviewVersion: s.webviewVersion, fontScale: s.fontScale, model: s.model,
    }
    pass('systeminfo', 'androidRelease（真值一致）', String(s.androidRelease) === String(facts.release), `插件=${s.androidRelease} getprop=${facts.release}`)
    pass('systeminfo', 'androidSdk（真值一致）', Number(s.androidSdk) === Number(facts.sdk), `插件=${s.androidSdk} getprop=${facts.sdk}`)
    pass('systeminfo', 'webviewVersion（与 dumpsys 一致）', String(s.webviewVersion) === String(facts.webview.version), `插件=${s.webviewVersion} dumpsys=${facts.webview.version}`)
    pass('systeminfo', 'webviewPackage（与 dumpsys 一致）', String(s.webviewPackage) === String(facts.webview.provider), `插件=${s.webviewPackage}`)
    pass('systeminfo', 'fontScale（与 system.font_scale 一致）', Math.abs(Number(s.fontScale) - settingScale) < 0.001, `插件=${s.fontScale} settings=${facts.fontScaleSetting}`)
    pass('systeminfo', 'model 非 unknown', Boolean(s.model) && s.model !== 'unknown', `model=${s.model}`)
  }

  // ── 5.2 UA 交叉校验（DeviceInfo 走 UA，属交叉而非结论）─────────────────
  const ua = await cdp.evaluate('navigator.userAgent')
  const uaAndroid = /Android\s+([\d.]+)/i.exec(ua)?.[1] ?? 'unknown'
  const uaWebview = /\bwv\b/.test(ua) ? (/Chrome\/([\d.]+)/i.exec(ua)?.[1] ?? 'unknown') : 'unknown'
  systeminfo.fields.uaParsed = { androidVersion: uaAndroid, webviewVersion: uaWebview }
  record('systeminfo', 'UA 派生 androidVersion 与真值一致（交叉校验）', uaAndroid === String(facts.release), `UA=${uaAndroid} 真值=${facts.release}`)
  record('systeminfo', 'UA 派生 webviewVersion 与真值一致（交叉校验）',
    String(facts.webview.version).startsWith(String(uaWebview).split('.')[0]) ? 'pass' : 'fail',
    `UA=${uaWebview} dumpsys=${facts.webview.version}`)

  // ── 5.3 日志导出 JSON（用户点「保存日志文件」实际会写盘的内容）───────────
  const bridge = await installBridgeCapture(cdp, { failDiagnostics: false }).catch((e) => String(e.message))
  record('systeminfo', '注入 nativePromise 桥拦截（拿到导出全文，不开 SAF 弹窗）', bridge === 'ok', String(bridge))
  let exportParsed = null
  if (bridge === 'ok') {
    if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`))) await openSettings(cdp)
    await openFeedback(cdp)
    const saved = await clickSaveLog(cdp)
    const capture = await readCapture(cdp)
    exportParsed = capture.parsed
    systeminfo.exportPayload = exportParsed
      ? {
          format: exportParsed.format,
          schemaVersion: exportParsed.schemaVersion,
          delivery: exportParsed.delivery,
          app: exportParsed.app,
          device: exportParsed.device,
          limits: exportParsed.limits,
          logCount: Array.isArray(exportParsed.logs) ? exportParsed.logs.length : null,
          bytes: capture.exportBytes,
        }
      : { raw: '解析失败', exportBytes: capture.exportBytes }
    record('systeminfo', '「保存日志文件」产出可解析 JSON（导出通道可用）',
      Boolean(exportParsed?.format === 'deepseek-feedback-diagnostics'),
      `点击=${saved} 字节=${capture.exportBytes} format=${exportParsed?.format}`)
    if (exportParsed) {
      const dev = exportParsed.device || {}
      const sys = dev.system || {}
      const caps = sys.capabilities || {}
      const rows = [
        ['androidVersion(UA 派生)', dev.androidVersion, uaAndroid],
        ['webviewVersion(UA 派生)', dev.webviewVersion, uaWebview],
        ['androidRelease(原生)', sys.androidRelease, facts.release],
        ['androidSdk(原生)', sys.androidSdk, facts.sdk],
        ['webviewPackage(原生)', sys.webviewPackage, facts.webview.provider],
        ['webviewVersion(原生)', sys.webviewVersion, facts.webview.version],
        ['fontScale(原生)', sys.fontScale, settingScale],
        ['nativePath', sys.nativePath, 'DiagnosticsDevice'],
      ]
      systeminfo.fields.exportJson = Object.fromEntries(rows.map(([k, v]) => [k, v]))
      for (const [name, actual, expected] of rows) {
        const ok = expected === 'DiagnosticsDevice'
          ? String(actual) === 'DiagnosticsDevice'
          : String(actual) === String(expected) || Math.abs(Number(actual) - Number(expected)) < 0.001
        pass('systeminfo', `导出 JSON 含 ${name} 且与真值一致`, ok, `payload=${actual} 真值=${expected}`)
      }
      const capOk = ['hasOwn', 'at', 'toSorted', 'dvh', 'visualViewport'].every((k) => k in caps)
      systeminfo.fields.exportCapabilities = caps
      record('systeminfo', '导出 JSON 含能力探测字段（capabilities 5 项齐全）', capOk ? 'pass' : 'fail',
        JSON.stringify(caps))
      if (probeOut?.capRows) {
        const mismatched = []
        for (const [key, row] of Object.entries(probeOut.capRows)) {
          const exported = caps[key === 'arrayAt' ? 'at' : key]
          if (exported === undefined) continue
          if (Boolean(exported) !== Boolean(row.available)) mismatched.push(`${key}: payload=${exported} probe=${row.available}`)
        }
        record('systeminfo', '导出里的能力探测与应用自身探测一致', mismatched.length === 0 ? 'pass' : 'fail', mismatched.join('; ') || '一致')
      }
    }
  }

  // ── 5.4 上传 payload：**刻意不触发** ─────────────────────────────────────
  // 教训（本轮实测）：Android WebView 里 Capacitor 把 window.fetch 劫持到原生 CapacitorHttp 插件，
  // 页面级 fetch 拦截既拿不到 body 也拦不住请求 —— 点「提交」会真的 POST 到反馈服务。
  // 兼容性矩阵禁止真实上传，因此这里只验证「导出」通道（同一份 snapshot 数据源），
  // 上传链路留给带 mock transport 的 integration 层（tests/integration/diagnostics*.test.mjs）。
  skip(
    'systeminfo',
    '上传 body 字段（刻意不触发真实提交）',
    '为避免真实提交到反馈服务，矩阵不点击「提交」；上传链路由 integration 层 mock transport 覆盖，导出 JSON 已证明字段真实'
  )

  // ── 5.5 fallback：原生插件不可用时不许阻塞 ───────────────────────────────
  try {
    const source = `(() => {
      const patch = () => {
        if (!window.Capacitor || typeof window.Capacitor.nativePromise !== 'function' || window.__compatPatched) return false
        window.__compatPatched = true
        const orig = window.Capacitor.nativePromise.bind(window.Capacitor)
        window.__compatNative = { calls: [], exportText: [], uploads: [], failDiagnostics: true }
        window.Capacitor.nativePromise = async (plugin, method, options) => {
          window.__compatNative.calls.push(plugin + '.' + method)
          if (plugin === 'DiagnosticsDevice' && method === 'snapshot') throw new Error('COMPAT_MATRIX_FORCED_FALLBACK')
          if (plugin === 'ExportText') {
            if (method === 'start') { window.__compatNative.exportText = []; return { id: 'compat-matrix', status: 'ready' } }
            if (method === 'writeChunk') { window.__compatNative.exportText.push(options && options.data ? options.data : ''); return {} }
            if (method === 'finish') return { status: 'saved' }
            if (method === 'abort') return {}
          }
          return orig(plugin, method, options)
        }
        return true
      }
      if (!patch()) { const timer = setInterval(() => { if (patch()) clearInterval(timer) }, 20) }
    })()`
    const injected = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })
    await cdp.send('Page.reload')
    await sleep(6000)
    const afterReload = await cdp.evaluate(`(() => {
      const text = (document.body?.innerText || '').trim()
      return { nodeCount: document.querySelectorAll('*').length, textLength: text.length, hasTextarea: !!document.querySelector('textarea'), head: text.slice(0, 120) }
    })()`)
    record('systeminfo', 'fallback：原生快照被强制失败后 App 仍渲染（未白屏/未崩）',
      !(afterReload.nodeCount < 8 || (afterReload.textLength === 0 && !afterReload.hasTextarea)),
      JSON.stringify(afterReload))
    const opened = await openFeedback(cdp)
    record('systeminfo', 'fallback：反馈弹窗仍可打开', opened.opened === true, JSON.stringify(opened.dialogState?.buttons ?? ''))
    if (opened.opened) {
      await clickSaveLog(cdp)
      const cap = await readCapture(cdp)
      const parsed = cap.parsed
      const sys = parsed?.device?.system ?? {}
      systeminfo.fallback = {
        exportStillWorks: Boolean(parsed?.format === 'deepseek-feedback-diagnostics'),
        nativePath: sys.nativePath ?? null,
        androidSdk: sys.androidSdk ?? null,
        fontScale: sys.fontScale ?? null,
        androidVersion: parsed?.device?.androidVersion ?? null,
        webviewVersion: parsed?.device?.webviewVersion ?? null,
      }
      record('systeminfo', 'fallback：导出仍产出合法 JSON（降级不阻塞）',
        Boolean(parsed?.format === 'deepseek-feedback-diagnostics'),
        `nativePath=${systeminfo.fallback.nativePath} androidSdk=${systeminfo.fallback.androidSdk} UA 派生 Android=${systeminfo.fallback.androidVersion}`)
      record('systeminfo', 'fallback：UA 派生设备字段仍在（androidVersion/webviewVersion 不为 unknown）',
        systeminfo.fallback.androidVersion !== 'unknown' && systeminfo.fallback.webviewVersion !== 'unknown',
        `${systeminfo.fallback.androidVersion} / ${systeminfo.fallback.webviewVersion}`)
      if (systeminfo.fallback.androidSdk === null || systeminfo.fallback.fontScale === null) {
        systeminfo.caveats.push('fallback 路径下 androidSdk / fontScale 缺失（原生快照不可用时的已知降级），不影响导出与提交，但排查硬件问题会少字段。')
      }
    }
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier }).catch(() => {})
    await cdp.send('Page.reload')
    await sleep(5000)
    await installBridgeCapture(cdp, { failDiagnostics: false }).catch(() => {})
  } catch (error) {
    record('systeminfo', 'fallback 复现', 'fail', String(error.message).slice(0, 200))
  }

  const file = `${OUT_DIR}${API}-systeminfo.json`
  writeFileSync(file, `${JSON.stringify(systeminfo, null, 2)}\n`)
  console.log(`     systeminfo 报告: ${file}`)
  return { ...systeminfo, file }
}

/** 大字体（1.3 / 1.5）：改 system.font_scale → 重启 App → 反馈弹窗里看提交按钮是否仍可达 */
const stageFontScale = async (facts) => {
  console.log('\n[6] 大字体（1.3 / 1.5）下的反馈弹窗')
  const results = []
  for (const scale of [1.3, 1.5]) {
    setFontScale(scale)
    await sleep(1500)
    const pid = await launchApp()
    if (!pid) {
      record('fontscale', `font_scale=${scale} 重启 App`, 'fail', 'App 未启动')
      continue
    }
    const { cdp } = await attach(pid)
    try {
      const applied = await cdp.evaluate(
        `({ innerWidth, innerHeight, dpr: devicePixelRatio, bodyFont: getComputedStyle(document.body).fontSize, rootFont: getComputedStyle(document.documentElement).fontSize })`
      )
      const nativeScale = await cdp
        .evaluate(`(async () => {
          try {
            const snap = await window.Capacitor.registerPlugin('DiagnosticsDevice').snapshot()
            return snap.fontScale
          } catch (e) { return null }
        })()`)
        .catch(() => null)
      record(
        'fontscale',
        `font_scale=${scale} 已生效且被采集`,
        Math.abs(Number(nativeScale) - scale) < 0.01,
        `插件 fontScale=${nativeScale} 视口=${applied.innerWidth}x${applied.innerHeight} rootFont=${applied.rootFont}`
      )
      const open = await openFeedback(cdp)
      if (!open.opened) {
        skip('fontscale', `font_scale=${scale} 下反馈弹窗可用`, '弹窗未打开')
      } else {
        const layout = await cdp.evaluate(`(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')]
          const top = dialogs[dialogs.length - 1]
          const btns = [...top.querySelectorAll('button')]
          const submit = btns.find((b) => /提交|Submit/i.test(b.textContent || ''))
          const save = btns.find((b) => /保存日志|Save log/i.test(b.textContent || ''))
          const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } }
          if (submit) submit.scrollIntoView({ block: 'center' })
          const r = submit ? submit.getBoundingClientRect() : null
          const clipped = top.scrollHeight > top.clientHeight + 4
          return {
            submit: rect(submit),
            save: rect(save),
            submitReachable: !!submit && !!r && r.top >= 0 && r.bottom <= innerHeight && r.height > 0,
            submitDisabled: submit ? submit.disabled : null,
            dialogClipped: clipped,
            dialogScroll: { scrollHeight: top.scrollHeight, clientHeight: top.clientHeight },
            textOverflow: document.body.scrollWidth > innerWidth,
          }
        })()`)
        pass(
          'fontscale',
          `font_scale=${scale} 提交按钮仍可达（未被布局挤掉）`,
          layout.submitReachable,
          JSON.stringify(layout)
        )
        await shot(cdp, `font-${String(scale).replace('.', '_')}`)
        results.push({ scale, layout, nativeScale })
      }
    } finally {
      cdp.socket.close()
      shQuiet('shell', 'am', 'force-stop', PACKAGE)
    }
  }
  setFontScale(null)
  return results
}

// ── 结论：三分类（该内核确实失败 / 该内核通过 / 未覆盖-不可判定）───────────────
const verdictOf = (groups) => {
  const byGroup = (g) => checks.filter((c) => c.group === g)
  const count = (g) => {
    const rows = byGroup(g)
    return {
      pass: rows.filter((r) => r.status === 'pass').length,
      fail: rows.filter((r) => r.status === 'fail').length,
      skip: rows.filter((r) => r.status === 'skip').length,
      total: rows.length,
    }
  }
  const core = ['startup', 'feedback', 'import', 'systeminfo']
  const coreFails = core.flatMap((g) => byGroup(g).filter((r) => r.status === 'fail'))
  const capFails = byGroup('capability').filter((r) => r.status === 'fail')
  const coreSkips = core.flatMap((g) => byGroup(g).filter((r) => r.status === 'skip'))
  const startupWhite = byGroup('startup').some((r) => r.name.includes('非白屏') && r.status === 'fail')

  let verdict = 'uncovered'
  const reasons = []
  if (startupWhite || coreFails.length > 0) {
    verdict = 'kernel-fails'
    reasons.push(
      `应用在本内核上有 ${coreFails.length} 条硬失败` +
        (startupWhite ? '（含首屏未渲染/白屏）' : '')
    )
    for (const f of coreFails.slice(0, 6)) reasons.push(`- [${f.group}] ${f.name}: ${f.detail}`)
  } else if (coreSkips.length > 0) {
    verdict = 'uncovered'
    reasons.push(`${coreSkips.length} 条核心检查因前置条件失败被跳过，无法判定`)
    for (const s of coreSkips.slice(0, 6)) reasons.push(`- [${s.group}] ${s.name}: ${s.detail}`)
  } else {
    verdict = 'kernel-pass'
    reasons.push('核心检查（首屏渲染 / 反馈弹窗 / 导入入口 / 系统信息）全部通过')
    if (capFails.length > 0) {
      reasons.push(
        `注意：有 ${capFails.length} 条能力探测与内核版本预期不一致（可能走了降级分支，需人工确认）`
      )
    }
  }
  const groupsOut = {}
  for (const g of [...new Set(checks.map((c) => c.group))]) groupsOut[g] = count(g)
  return { verdict, reasons, groups: groupsOut }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const run = async () => {
  mkdirSync(SHOT_DIR, { recursive: true })
  if (!existsSync(APK)) throw new Error(`找不到 APK: ${APK}`)
  const apkSha = createHash('sha256').update(readFileSync(APK)).digest('hex')

  console.log(`[compat-matrix] API=${API} AVD=${AVD} serial=${SERIAL}`)
  console.log(`[apk] ${APK}\n      sha256=${apkSha}`)

  const facts = deviceFacts()
  console.log(
    `[device] Android ${facts.release} (SDK ${facts.sdk}) ${facts.flavor} / ${facts.abi} / ${facts.model}`
  )
  console.log(
    `[webview] provider=${facts.webview.provider} version=${facts.webview.version} impl=${facts.webview.implementation}`
  )
  pass('device', `镜像确认为 API ${API}`, Number(facts.sdk) === Number(API), `ro.build.version.sdk=${facts.sdk}`)
  pass('device', 'google_apis x86_64 镜像（非 Play/非 arm）', facts.flavor.includes('sdk_gphone'), facts.flavor)

  const bundle = analyzeBundle()
  if (bundle.error) {
    record('bundle', '产物静态分析', 'skip', bundle.error)
  } else {
    const kernel = Number(String(deviceFacts().webview.version).split('.')[0])
    const blocking = bundle.features.filter((f) => f.needsChrome > kernel)
    record(
      'bundle',
      `构建基线（rspack targets）声明的最低 Chrome：${bundle.targets[0]}`,
      'pass',
      `产物 ${bundle.bundle}（${(bundle.bytes / 1024 / 1024).toFixed(2)}MB）`
    )
    record(
      'bundle',
      `产物里高版本语法/API 与本内核（Chrome ${kernel}）兼容`,
      blocking.length === 0 ? 'pass' : 'fail',
      blocking.length === 0
        ? `扫描到的最高要求 = Chrome ${Math.max(...bundle.features.map((f) => f.needsChrome), 0)}`
        : `${blocking.length} 处超出：` +
          blocking.map((f) => `${f.feature}需${f.needsChrome}+ @${f.index}`).join('，') +
          ` ｜示例片段：…${blocking[0].snippet}…`
    )
  }

  if (!SKIP_INSTALL) {
    await setFontScale(null)
    console.log('[install] ' + (shQuiet('install', '-r', APK) || 'no-output'))
    shQuiet('logcat', '-c')
  }

  const pid = await launchApp()
  if (!pid) throw new Error('App 启动失败（pidof 为空）')
  const { cdp } = await attach(pid)
  console.log(`[cdp] pid=${pid}`)

  let startup = { whiteScreen: true }
  try {
    startup = await stageStartup(cdp)
  } catch (error) {
    record('startup', '首屏渲染检查执行', 'fail', String(error.message).slice(0, 200))
  }
  let probeOut = null
  try {
    probeOut = await stageProbe(cdp, facts)
  } catch (error) {
    record('capability', '能力探测执行', 'fail', String(error.message).slice(0, 200))
  }

  // 白屏 / 致命异常时不要硬跑后续交互（会把「不可判定」写成「失败」）
  // fatal 只看「首屏真的不可用」：白屏，或 ChatInput 没渲染出来。
  // consoleErrors 里的 TypeError 只作为证据记录——它可能只是某个非关键路径降级失败，不该一刀切跳过全部交互。
  const fatal = startup.whiteScreen || !startup.render?.hasTextarea
  let feedbackOut = null
  let importOut = null
  let systemOut = null
  if (fatal) {
    console.log('\n[skip] 首屏不可用（白屏或致命异常），跳过交互类检查并记为「未覆盖/不可判定」')
    skip('feedback', '反馈弹窗（滚动/保存日志/取消保留/键盘）', '首屏不可用，不可判定')
    skip('import', '从链接导入全流程', '首屏不可用，不可判定')
    skip('systeminfo', '系统信息字段采集', '首屏不可用，不可判定')
  } else {
    try {
      feedbackOut = await stageFeedback(cdp)
    } catch (error) {
      record('feedback', '反馈弹窗检查执行', 'fail', String(error.message).slice(0, 200))
    }
    // 导入需要干净状态：先关掉弹窗
    await cdp.evaluate(`(() => { document.querySelectorAll('[role="dialog"]').forEach(() => {}) })()`).catch(() => {})
    const archive = buildArchive({ sessionCount: 8, imageBytes: 512 * 1024 })
    mkdirSync('/tmp/compat-archive', { recursive: true })
    writeFileSync('/tmp/compat-archive/deepseek_data.zip', archive.zip)
    const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '0.0.0.0'], {
      cwd: '/tmp/compat-archive',
      stdio: 'ignore',
    })
    await sleep(1200)
    try {
      importOut = await stageImport(cdp, archive)
    } catch (error) {
      record('import', '导入检查执行', 'fail', String(error.message).slice(0, 200))
    } finally {
      server.kill()
    }
    try {
      systemOut = await stageSystemInfo(cdp, facts, probeOut)
    } catch (error) {
      record('systeminfo', '系统信息检查执行', 'fail', String(error.message).slice(0, 200))
    }
  }

  // logcat 崩溃/ANR
  const logcat = shQuiet('logcat', '-d', '-t', '3000')
  const crashes = logcat
    .split('\n')
    .filter((l) => /FATAL EXCEPTION|ANR in com\.example\.deepseekchat|chromium.*Uncaught/.test(l))
  record('logcat', '无崩溃 / ANR', crashes.length === 0 ? 'pass' : 'fail', crashes.slice(0, 3).join(' | ').slice(0, 300))
  cdp.socket.close()

  // 大字体阶段需要重启 App，放在最后（会重置表单与 CDP 连接）
  let fontOut = null
  if (!fatal) {
    try {
      fontOut = await stageFontScale(facts)
    } catch (error) {
      record('fontscale', '大字体检查执行', 'fail', String(error.message).slice(0, 200))
    }
  } else {
    skip('fontscale', '大字体 1.3 / 1.5', '首屏不可用，不可判定')
  }

  const verdict = verdictOf()
  const report = {
    api: Number(API),
    avd: AVD,
    serial: SERIAL,
    generatedAt: new Date().toISOString(),
    artifact: { apk: APK, sha256: apkSha, versionName: 'see-apk', note: 'built from worktree' },
    device: facts,
    probe: probeOut,
    startup: startup.render ?? startup,
    consoleErrors,
    logcatCrashes: crashes,
    insights: { feedback: feedbackOut, import: importOut, systeminfo: systemOut, fontscale: fontOut },
    checks,
    screenshots: shots,
    verdict,
    caveats: [
      'AOSP google_apis 镜像结果不代表 ColorOS / 荣耀 MagicOS 等 OEM WebView 真机结果：OEM 自带 WebView 版本、输入法、window inset 行为不同，仍需真机复测。',
      '无头模拟器不弹真软键盘：键盘遮挡若是 simulated=true，则只证明布局在 visualViewport 收缩下不遮挡，不等于真机输入法实测。',
      'fontScale 通过 system.font_scale 设置，等价于用户调大系统字体，但不等价于 OEM 的「字体+显示大小」组合档位。',
    ],
  }
  const outFile = `${OUT_DIR}${API}.json`
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`\n[report] ${outFile}`)
  console.log(`[verdict] ${verdict.verdict} — ${verdict.reasons[0]}`)
  for (const [g, c] of Object.entries(verdict.groups)) {
    console.log(`   ${g}: pass=${c.pass} fail=${c.fail} skip=${c.skip} (总 ${c.total})`)
  }
  if (verdict.verdict === 'kernel-fails') process.exitCode = 1
}

await run()
