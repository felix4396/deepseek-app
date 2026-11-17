// 新用例（1.2.3）：Anthropic 协议不支持搜索 / 附件 / 语音，这三个入口必须隐藏或置灰，
// 「深度思考」保留可用（该协议仍支持 thinking）。
//
// 跑法：APP_URL=http://127.0.0.1:5181 node tests/test.caps-anthropic.spec.mjs
import {
  closeSettings,
  fillApiKey,
  finish,
  openApp,
  openSettingsDataSection,
  selectProviderKind,
} from './helpers.mjs'

const name = 'test.caps-anthropic.spec.mjs'
const { browser, page } = await openApp()
const failures = []

/** 按钮不可见，或可见但置灰（aria-disabled），都算降级成功 */
const expectDegraded = async (label, nameRe) => {
  const button = page.getByRole('button', { name: nameRe })
  if ((await button.count()) === 0) {
    console.log(`ok: ${label} 入口已隐藏`)
    return
  }
  const first = button.first()
  if (!(await first.isVisible())) {
    console.log(`ok: ${label} 入口不可见`)
    return
  }
  const disabled =
    (await first.getAttribute('aria-disabled')) === 'true' || (await first.isDisabled())
  if (disabled) {
    console.log(`ok: ${label} 入口已置灰`)
    return
  }
  failures.push(`${label} 在 Anthropic 模式下仍然可用（既没有隐藏也没有置灰）`)
}

try {
  await openSettingsDataSection(page)
  await selectProviderKind(page, /Anthropic 协议|Anthropic-compatible/)
  await fillApiKey(page, 'sk-testkey-caps')
  await closeSettings(page)

  await expectDegraded('智能搜索', /^智能搜索$|^Search$/)
  await expectDegraded('上传文件（附件）', /^上传文件$|^Upload files$/)
  await expectDegraded('语音输入', /^语音输入$|^Voice input$/)

  // 深度思考必须保留
  const thinking = page.getByRole('button', { name: /^深度思考$|^DeepThink$/ })
  if ((await thinking.count()) === 0 || !(await thinking.first().isVisible())) {
    failures.push('Anthropic 模式下「深度思考」被误删了，应该保留')
  } else if ((await thinking.first().getAttribute('aria-disabled')) === 'true') {
    failures.push('Anthropic 模式下「深度思考」被置灰了，thinking 仍应可用')
  } else {
    console.log('ok: 深度思考仍然可用')
  }
} catch (error) {
  failures.push(`用例异常：${error instanceof Error ? error.message : String(error)}`)
} finally {
  await finish(browser, name, failures)
}
