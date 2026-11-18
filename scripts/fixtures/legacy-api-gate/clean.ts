// 对照产物：不含任何 Chrome 83 之后的内置 API —— check:legacy 应当 exit 0。
const rows: string[] = ['b', 'a']
const view = rows.slice().sort().join(',')
console.log('[fixture:clean] sorted ->', view)
