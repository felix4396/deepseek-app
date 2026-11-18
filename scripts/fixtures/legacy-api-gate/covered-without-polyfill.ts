// beta.8 事故形态：代码没变，但 polyfill 没进产物（旧基线拉 release 分支 / 漏 import）。
// 桌面内核一切正常，WebView 83 上 `Object.hasOwn is not a function` -> 整屏白屏。
// 门禁必须在这里 exit 1（issue #39 的主判据）。
const record: Record<string, number> = { a: 1 }
const list: string[] = ['x', 'y']
console.log(
  '[fixture:covered-without-polyfill] hasOwn(a) ->',
  Object.hasOwn(record, 'a'),
  '| list.at(-1) ->',
  list.at(-1)
)
