// [layer: unit | fetch mock only; zero upstream traffic/key | <1s]
// Default: fixed acceptance. EXPECT_429_BASELINE=1: pin original beta7 reproduction.
// Node 22: node --experimental-transform-types --test tests/unit/429-error-mapping.test.mjs
import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { readFileSync } from 'node:fs'
import { test, after } from 'node:test'
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && !url.includes('/node_modules/')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true }
    }
    return nextLoad(url, context)
  },
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})
globalThis.__API_ORIGIN__ = 'https://fixture.invalid'
globalThis.__INTERNAL_BUILD__ = true
const storage = new Map([['chat-demo:locale', 'zh-CN']])
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const { ApiError, streamMessage } = await import('../../src/services/api/client.ts')
const { classifyApiError, isRetryableApiError } = await import('../../src/services/api/errors.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { errorMeta } = await import('../../src/services/diagnostics/collector.ts')
const originalFetch = globalThis.fetch
after(() => { globalThis.fetch = originalFetch })
const acceptance = process.env.EXPECT_429_BASELINE !== '1'
const quota = { code: 'insufficient_quota', type: 'insufficient_quota', message: 'API额度用完，请更换Key' }
const rate = { code: 'rate_limit_exceeded', type: 'rate_limit_error', message: 'Requests per minute exceeded' }
const body = { model: 'fixture-model', system: '', messages: [{ role: 'user', content: 'fixture' }], max_tokens: 1 }

async function mockFailure(provider, detail, { sse = false, retryAfter = '30' } = {}) {
  storage.set('chat-demo:provider-kind', provider)
  if (provider === 'openai' || provider === 'anthropic') {
    storage.set(`chat-demo:base-url:${provider}`, 'https://fixture.invalid')
  }
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(init.method, 'POST')
    assert.match(String(url), /\/(chat\/completions|messages)$/)
    // This stub is the only fetch path. Even ours' locked URL never leaves this process.
    return new Response(sse ? `data: ${JSON.stringify({ error: detail })}\n\n` : JSON.stringify({ error: detail }), {
      status: sse ? 200 : 429,
      headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', 'retry-after': retryAfter, 'x-request-id': 'fixture-request', 'set-cookie': 'fixture-sensitive' },
    })
  }
  let captured
  try {
    for await (const _event of streamMessage('fixture-key-not-real', body, new AbortController().signal)) {}
  } catch (error) { captured = error }
  assert.equal(calls, 1)
  assert.ok(captured instanceof ApiError)
  return captured
}

// Mirror store.ts:1227-1232 persisted fields, then call the real UI notice function.
const notice = (error) => describeReply({ status: 'error', blocks: [], error: {
  kind: error.kind, message: error.message, status: error.status, upstream: error.upstream, localMessage: error.localMessage,
} })

for (const provider of ['ours', 'openai', 'deepseek', 'anthropic']) {
  test(`${provider}: HTTP429 quota ${acceptance ? 'acceptance' : 'beta7 reproduction'}`, async () => {
    const error = await mockFailure(provider, quota)
    assert.equal(error.status, 429)
    assert.equal(error.message, quota.message, 'original upstream message survives HTTP parsing')
    if (acceptance) {
      assert.equal(error.upstream.code, quota.code, 'retain upstream code separately from local ApiError.code')
      assert.equal(error.upstream.type, quota.type)
      assert.equal(error.upstream.headers['retry-after'], '30')
      assert.equal(error.upstream.headers['x-request-id'], 'fixture-request')
      assert.equal(error.upstream.headers['set-cookie'], undefined, 'only allowlisted headers survive')
      assert.equal(errorMeta(error)['upstream.code'], quota.code)
      assert.match(notice(JSON.parse(JSON.stringify(error))).text, /上游额度不足.*请更换\s*Key/, 'persisted error survives reload')
      assert.equal(classifyApiError(error), 'quotaExhausted')
      assert.match(notice(error).text, /上游额度不足.*请更换\s*Key/)
      assert.equal(isRetryableApiError(error), false)
    } else {
      assert.equal(error.code, undefined, 'BUG: error.code/type discarded')
      assert.equal(error.upstreamCode, undefined)
      assert.equal(classifyApiError(error), 'rateLimited', 'BUG: status-only classification')
      assert.equal(notice(error).text, '请求过于频繁，请稍后再试', 'BUG: UI overwrites quota message')
      assert.equal(isRetryableApiError(error), true, 'BUG: quota marked retryable (not proof of automatic retries)')
      const meta = errorMeta(error)
      assert.equal(meta['http.status'], 429)
      assert.match(meta['error.msg'], /API额度用完/)
      assert.equal(meta['upstream.code'], undefined, 'diagnostics retain message/status but no code')
      assert.equal(error.retryAfter, undefined, 'Retry-After not retained')
    }
  })
}
test('ours: true HTTP429 rate limit remains readable frequency hint', async () => {
  const error = await mockFailure('ours', rate)
  assert.equal(error.message, rate.message)
  assert.equal(classifyApiError(error), 'rateLimited')
  assert.equal(notice(error).text, '请求过于频繁，请稍后再试')
  assert.equal(isRetryableApiError(error), true)
})
test('ours: quota message without structured code keeps original wording without guessing', async () => {
  const error = await mockFailure('ours', { message: quota.message })
  if (acceptance) {
    assert.equal(classifyApiError(error), 'other', 'no machine semantics: do not guess quota or rate')
    assert.equal(notice(error).text, quota.message)
  } else {
    assert.equal(error.message, quota.message)
    assert.equal(notice(error).text, '请求过于频繁，请稍后再试')
  }
})
test('ours: unknown code and Retry-After do not prove frequency or quota', async () => {
  const error = await mockFailure('ours', { code: 'gateway_429', message: 'Upstream rejected request' })
  assert.equal(error.upstream.code, 'gateway_429')
  assert.equal(classifyApiError(error), 'other')
  assert.equal(notice(error).text, 'Upstream rejected request')
  assert.equal(isRetryableApiError(error), false)
})
test('ours: explicit quota type works when code is absent', async () => {
  const error = await mockFailure('ours', { type: 'insufficient_quota', message: quota.message })
  assert.equal(classifyApiError(error), 'quotaExhausted')
  assert.match(notice(error).text, /上游额度不足/)
})
test('ours: HTTP200 SSE error is a separate stream path, not HTTP429 mapping', async () => {
  const error = await mockFailure('ours', quota, { sse: true })
  assert.equal(error.kind, 'stream')
  assert.equal(error.status, undefined)
  assert.equal(error.message, quota.message)
  assert.equal(classifyApiError(error), 'other')
  assert.equal(notice(error).text, quota.message)
})
