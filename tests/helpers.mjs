// 共享的 Playwright 步骤：打开设置 → 数据管理，并捕获 /models 探测请求。
import { chromium } from 'playwright'

export const APP_URL = process.env.APP_URL || 'http://100.113.135.55:5181'
export const FAKE_KEY = 'sk-testkey-0123456789'

/** 启动浏览器并进入「干净」的应用状态：清掉 localStorage 里已保存的配置后重载 */
export const openApp = async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  return { browser, page }
}

/** 没有 API Key 时应用会自己弹出设置并选中「数据管理」；已弹出就只切分组 */
export const openSettingsDataSection = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    await page.getByRole('button', { name: /设置|Settings/ }).last().click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  // 已保存 Key 时密码框是隐藏的（只显示掩码），等不到不算错
  await page.waitForSelector('input[type="password"]', { timeout: 3000 }).catch(() => {})
}

/** 监听 /models 请求，返回数组（元素为 { url, authorization }） */
export const captureProbeRequests = (page) => {
  const captured = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('/models')) {
      captured.push({ url: request.url(), authorization: request.headers()['authorization'] })
    }
  })
  return captured
}

/** 点服务地址那一行的「测试」按钮 */
export const clickTest = async (page) => {
  await page.getByRole('button', { name: /^测试$|^Test$/ }).first().click()
}

/** 等待第一条探测请求出现（等不到返回 false） */
export const waitForProbe = async (page, captured, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (captured.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100)
  }
  return captured.length > 0
}

/** 统一的收尾：打印失败原因并以非 0 退出，或用例通过 */
export const finish = async (browser, name, failures) => {
  await browser.close()
  if (failures.length > 0) {
    console.error(`\nFAIL ${name}`)
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`)
    }
    process.exit(1)
  }
  console.log(`\nPASS ${name}`)
}
