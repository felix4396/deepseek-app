// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// 旧 Android WebView 兼容回归（beta7 紧急项）：
//   - `Array.prototype.toSorted` / `toReversed` 是 ES2023（Chrome/WebView 110+），旧 WebView 上直接抛
//     「e.messages.toSorted is not a function」——用户表现为导入失败 / 发消息失败。
// 本用例把这两个原型方法删掉后，走**真实函数**：
//   1 toLocalSession()（toLocal.ts 的 buildTree 里曾用 toSorted）
//   2 store 的模块加载 + retryUpload()（prepareFiles 里曾用 toReversed）
// 并静态断言这两个新 API 不再出现在调用点上（防止回退）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

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

// 打包期 DefinePlugin 常量，裸 Node 里没有；store 模块顶层会用到
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= true

let toLocalModule = null
let toLocalSkipReason = ''
try {
  toLocalModule = await import('../../src/services/chat/history/toLocal.ts')
} catch (error) {
  if (String(error?.code) === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    toLocalSkipReason = `toLocal.ts 在 strip-only 模式下不可加载（${error.code}）；用 NODE_OPTIONS=--experimental-transform-types 跑真实路径`
  } else {
    throw error
  }
}

/** 造一个最小但合法的导出差会话文件：id 故意乱序，父链 1 ← 2 ← 3 */
const makeFile = () => ({
  id: 'legacy-webview-session',
  title: '旧 WebView',
  pinned: false,
  current_message_id: 3,
  inserted_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  messages: [
    {
      id: 3,
      parent_id: 2,
      role: 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: '2026-11-18T00:00:03Z',
      fragments: [{ type: 'REQUEST', content: '第三条' }],
    },
    {
      id: 1,
      parent_id: null,
      role: 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: '2026-11-18T00:00:01Z',
      fragments: [{ type: 'REQUEST', content: '第一条' }],
    },
    {
      id: 2,
      parent_id: 1,
      role: 'ASSISTANT',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: '2026-11-18T00:00:02Z',
      fragments: [{ type: 'RESPONSE', content: '第二条' }],
    },
  ],
})

const without = (proto, names) => {
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(proto, name)])
  for (const name of names) delete proto[name]
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(proto, name, descriptor)
    }
  }
}

test('没有 toSorted 时 toLocalSession 能正常导入会话（真实调用路径）', (t) => {
  if (!toLocalModule) {
    t.skip(toLocalSkipReason)
    return
  }
  const { toLocalSession } = toLocalModule
  const restore = without(Array.prototype, ['toSorted', 'toReversed'])
  try {
    assert.equal(typeof [].toSorted, 'undefined', '前置：已模拟旧 WebView（无 toSorted）')
    const local = toLocalSession(makeFile())
    assert.equal(local.session.messages.length, 3, '三个消息都要导入')
    assert.deepEqual(
      local.session.messages.map((m) => Number(m.id)),
      [1, 2, 3],
      '消息必须按 id 升序还原（原 toSorted 语义）'
    )
    assert.equal(local.session.messages[0].role, 'user', '根消息应是用户提问')
  } finally {
    restore()
  }
})

test('没有 toReversed 时 store 的发送/重试路径不因该 API 抛错（真实调用路径）', async (t) => {
  let store
  try {
    store = await import('../../src/services/chat/store.ts')
  } catch (error) {
    // 裸 node 的 strip-only 模式不认 TS「参数属性」；用 NODE_OPTIONS=--experimental-transform-types 跑才走真实路径
    if (String(error?.code) === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      t.skip(`store.ts 在 strip-only 模式下不可加载（${error.code}），改用静态核查覆盖；加 --experimental-transform-types 可跑真实路径`)
      return
    }
    throw error
  }
  const restore = without(Array.prototype, ['toSorted', 'toReversed'])
  try {
    assert.equal(typeof [].toReversed, 'undefined', '前置：已模拟旧 WebView（无 toReversed）')
    // 用一个不存在的会话触发 prepareFiles 前置分支；只要不是「toReversed is not a function」就算通过
    let message = ''
    try {
      await store.retryUpload('no-such-session', 'no-such-message')
    } catch (error) {
      message = String(error?.message ?? error)
    }
    assert.ok(
      !/toReversed is not a function|toSorted is not a function/.test(message),
      `不应再出现 ES2023 缺失错误，实际：${message || '(无异常)'}`
    )
  } finally {
    restore()
  }
})

test('调用点静态核查：src 里不再使用 toSorted/toReversed', () => {
  for (const file of [
    'src/services/chat/store.ts',
    'src/services/chat/history/toLocal.ts',
    'src/services/updateManifest.ts',
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    assert.ok(!/\.toSorted\(/.test(source), `${file} 仍在使用 .toSorted(`)
    assert.ok(!/\.toReversed\(/.test(source), `${file} 仍在使用 .toReversed(`)
  }
})
