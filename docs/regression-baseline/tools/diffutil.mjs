/** 极简行级 diff：返回 base 有而 after 没有的行（removed）与新增行（added） */
export const diffLines = (aLines, bLines) => {
  const a = aLines.split('\n')
  const b = bLines.split('\n')
  const aSet = new Map()
  for (const line of a) aSet.set(line, (aSet.get(line) ?? 0) + 1)
  const bSet = new Map()
  for (const line of b) bSet.set(line, (bSet.get(line) ?? 0) + 1)
  const removed = []
  for (const [line, count] of aSet) {
    const other = bSet.get(line) ?? 0
    for (let i = 0; i < count - other; i++) removed.push(line)
  }
  const added = []
  for (const [line, count] of bSet) {
    const other = aSet.get(line) ?? 0
    for (let i = 0; i < count - other; i++) added.push(line)
  }
  return { added, removed }
}
