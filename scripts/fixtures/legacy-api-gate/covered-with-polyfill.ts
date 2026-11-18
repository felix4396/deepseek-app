// 正常形态：业务代码裸调用 Object.hasOwn / .at()，由入口第一个 import 的 legacy polyfill 兜底。
// 这就是 origin/main 上的真实形态（src/services/chat/sessionGroups.ts 等），门禁应当 exit 0。
import '../../../src/polyfills/legacy.js'

const record: Record<string, number> = { a: 1 }
const list: string[] = ['x', 'y']
console.log(
  '[fixture:covered-with-polyfill] hasOwn(a) ->',
  Object.hasOwn(record, 'a'),
  '| list.at(-1) ->',
  list.at(-1)
)
