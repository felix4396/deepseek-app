#!/usr/bin/env node
// 在「目标运行时缺 API」的进程里跑产物 —— 模拟 WebView 83。
//
//   node run-without-api.mjs <产物 js 路径>
//
// 先把 Chromium 83 之后才有的内置 API 从当前进程删掉，再 import 产物：
//   · 产物里裸调用 -> 真抛 TypeError（这就是白屏的机制，不是模拟断言）
//   · 产物里补上了 polyfill -> 跑通
// 桌面/CI 的 Node 22 自带这些 API，所以不打这层补丁的话，缺 API 的产物在 CI 永远是绿的。
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const MISSING_IN_CHROME_83 = [
  ['String.prototype', 'replaceAll'],
  ['String.prototype', 'at'],
  ['Array.prototype', 'at'],
  ['Array.prototype', 'findLast'],
  ['Array.prototype', 'findLastIndex'],
  ['Array.prototype', 'toSorted'],
  ['Array.prototype', 'toReversed'],
  ['Array.prototype', 'toSpliced'],
  ['Array.prototype', 'with'],
  ['Object', 'hasOwn'],
  ['Object', 'groupBy'],
  ['Promise', 'any'],
]

const bundle = process.argv[2]
if (!bundle) {
  console.error('用法：node run-without-api.mjs <产物 js 路径>')
  process.exit(64)
}
const absolute = resolve(bundle)
if (!existsSync(absolute)) {
  console.error(`产物不存在：${absolute}`)
  process.exit(64)
}

const owners = {
  'String.prototype': String.prototype,
  'Array.prototype': Array.prototype,
  Object,
  Promise,
}
for (const [owner, name] of MISSING_IN_CHROME_83) {
  delete owners[owner][name]
}
delete globalThis.structuredClone

const stillThere = MISSING_IN_CHROME_83.filter(([owner, name]) => name in owners[owner])
if (stillThere.length) {
  console.error('没能删干净，复现环境不成立：', stillThere)
  process.exit(65)
}

globalThis.__FIXTURE_INPUT__ = 'a,b'

await import(pathToFileURL(absolute).href)
