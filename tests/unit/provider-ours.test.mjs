// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// 「我们的渠道」(ours) 2026-11-18 改走 OpenAI 协议的 focused 单测：
//   1 spec 契约：protocol=openai、auth=bearer、base=62.106.70.167:60010、model=deepseek-v4.1-flash、
//     messages=/v1/chat/completions、caps.thinking=false、locked=true、UI 字段只有 apiKey
//   2 迁移：localStorage 里旧的 ours 地址/模型必须被 locked defaults 覆盖；用户 API Key 保留
//   3 回归：另外三个渠道（deepseek / anthropic / openai）的协议口径不被这次改动带偏
// 绝不发真实请求、绝不内置任何 key。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

// 非打包环境兜底：DefinePlugin 注入的两个常量
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= true

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const { PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')
const cfg = await import('../../src/services/api/apiConfig.ts')

const specOf = (kind) => PROVIDER_SPECS.find((s) => s.kind === kind)

test('ours 渠道契约：OpenAI 协议 + Bearer + 内置新地址/模型', () => {
  const ours = specOf('ours')
  assert.equal(ours.protocol, 'openai', 'ours 必须走 openai 协议（经 openaiAdapter 翻译）')
  assert.equal(ours.auth, 'bearer', 'ours 鉴权必须是 Bearer')
  assert.equal(ours.defaults.baseUrl, 'http://62.106.70.167:60010')
  assert.equal(ours.defaults.model, 'deepseek-v4.1-flash')
  assert.equal(ours.paths.messages, '/v1/chat/completions', '请求路径必须是 chat/completions，不能仍是 /v1/messages')
  assert.equal(ours.paths.tools, '')
  assert.equal(ours.locked, true, '地址/模型必须锁定，设置页不渲染输入行')
  assert.deepEqual(ours.fields, ['apiKey'], '设置页只暴露 API Key 一行')
  assert.equal(ours.caps.text, true)
  assert.equal(ours.caps.thinking, false, 'OpenAI 路径没有 thinking，开关不能露出来')
  assert.equal(ours.anthropicVersion, undefined, 'OpenAI 协议不需要 anthropic-version 头')
})

test('ours 迁移：旧 base/model 被 locked defaults 覆盖，用户 Key 保留', () => {
  store.clear()
  store.set('chat-demo:provider-kind', 'ours')
  // 旧版内测包留下的持久化值
  store.set('chat-demo:base-url:ours', 'http://123.207.199.196:60010')
  store.set('chat-demo:model:ours', 'legacy-model-name')
  store.set('chat-demo:api-key', 'sk-user-provided-only-in-test-memory')

  assert.equal(cfg.getProviderKind(), 'ours')
  assert.equal(cfg.getBaseUrl(), 'http://62.106.70.167:60010', '旧地址必须被默认值覆盖')
  assert.equal(cfg.getModel(), 'deepseek-v4.1-flash', '旧模型必须被默认值覆盖')
  assert.equal(cfg.getApiKey(), 'sk-user-provided-only-in-test-memory', '用户自己填的 Key 必须保留')
  assert.equal(cfg.getMessagesUrl(), 'http://62.106.70.167:60010/v1/chat/completions')
})

test('另外三个渠道不受影响', () => {
  const deepseek = specOf('deepseek')
  assert.equal(deepseek.protocol, 'anthropic')
  assert.equal(deepseek.auth, 'x-api-key')
  assert.equal(deepseek.defaults.baseUrl, 'https://api.deepseek.com')

  const anthropic = specOf('anthropic')
  assert.equal(anthropic.protocol, 'anthropic')
  assert.equal(anthropic.auth, 'x-api-key')
  assert.deepEqual(anthropic.fields, ['baseUrl', 'apiKey', 'model'])
  assert.equal(anthropic.caps.thinking, true)

  const openai = specOf('openai')
  assert.equal(openai.protocol, 'openai')
  assert.equal(openai.auth, 'bearer')
  assert.equal(openai.paths.messages, '/v1/chat/completions')
  assert.deepEqual(openai.fields, ['baseUrl', 'apiKey', 'model'])

  // 用户切到 anthropic 时仍读自己填的地址，不被 ours 的锁定规则污染
  store.clear()
  store.set('chat-demo:provider-kind', 'anthropic')
  store.set('chat-demo:base-url:anthropic', 'https://api.anthropic.com')
  store.set('chat-demo:model:anthropic', 'claude-x')
  assert.equal(cfg.getBaseUrl(), 'https://api.anthropic.com')
  assert.equal(cfg.getModel(), 'claude-x')
})
