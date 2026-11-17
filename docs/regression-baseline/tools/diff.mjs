// 逐个场景比对 base / after 的录制产物，输出 PASS / FAIL / 预期差异
import fs from 'node:fs'
import path from 'node:path'
import { diffLines } from './diffutil.mjs'

const BASE = process.argv[2] ?? '/tmp/cdtest/base'
const AFTER = process.argv[3] ?? '/tmp/cdtest/after'
const base = JSON.parse(fs.readFileSync(path.join(BASE, 'report.json'), 'utf8'))
const after = JSON.parse(fs.readFileSync(path.join(AFTER, 'report.json'), 'utf8'))

const rows = []
const add = (area, item, verdict, detail) => rows.push({ area, item, verdict, detail })

// 1) 网络形态：请求集合（method + 路径）与 body 顶层字段
for (const [name, baseRec] of Object.entries(base.scenarios)) {
  const afterRec = after.scenarios[name]
  if (!afterRec) {
    add(name, '场景存在', 'FAIL', '改造后没有该场景')
    continue
  }
  const norm = (list) =>
    list
      .map((r) => `${r.method} ${new URL(r.origin).host}${r.path}`)
      .sort()
  const baseReq = norm(baseRec.requests)
  const afterReq = norm(afterRec.requests)
  const sameReq = JSON.stringify(baseReq) === JSON.stringify(afterReq)
  add(
    name,
    '请求 method+路径',
    sameReq ? 'PASS' : 'FAIL',
    sameReq ? baseReq.join(' | ') || '(无请求)' : `base=${baseReq.join(',')} after=${afterReq.join(',')}`
  )

  const baseFields = [...new Set(baseRec.requests.flatMap((r) => r.bodyTopLevelFields ?? []))].sort()
  const afterFields = [...new Set(afterRec.requests.flatMap((r) => r.bodyTopLevelFields ?? []))].sort()
  if (baseFields.length || afterFields.length) {
    const same = JSON.stringify(baseFields) === JSON.stringify(afterFields)
    add(name, '请求 body 顶层字段', same ? 'PASS' : 'FAIL', same ? baseFields.join(',') : `base=${baseFields.join(',')} after=${afterFields.join(',')}`)
  }
  const baseDetail = JSON.stringify(baseRec.requests.map((r) => r.bodyDetail ?? null))
  const afterDetail = JSON.stringify(afterRec.requests.map((r) => r.bodyDetail ?? null))
  if (baseDetail !== 'null') {
    add(name, 'body 关键值(stream/model/tools/safety)', baseDetail === afterDetail ? 'PASS' : 'FAIL', baseDetail === afterDetail ? baseDetail.slice(0, 200) : `base=${baseDetail} after=${afterDetail}`)
  }
  const baseHeaders = [...new Set(baseRec.requests.flatMap((r) => r.headerNames ?? []))].sort()
  const afterHeaders = [...new Set(afterRec.requests.flatMap((r) => r.headerNames ?? []))].sort()
  if (baseHeaders.length || afterHeaders.length) {
    const missing = baseHeaders.filter((h) => !afterHeaders.includes(h))
    add(name, '请求 header 名', missing.length ? 'FAIL' : 'PASS', missing.length ? `缺少 ${missing.join(',')}` : `${afterHeaders.join(',')}`)
  }
  const baseStatus = baseRec.responses.map((r) => `${r.method} ${r.path}->${r.status}`).sort()
  const afterStatus = afterRec.responses.map((r) => `${r.method} ${r.path}->${r.status}`).sort()
  if (baseStatus.length || afterStatus.length) {
    add(name, '响应状态码', JSON.stringify(baseStatus) === JSON.stringify(afterStatus) ? 'PASS' : 'FAIL', `base=${baseStatus.join(',')} after=${afterStatus.join(',')}`)
  }
  // 控制台错误
  const newErrors = afterRec.consoleErrors.filter((e) => !baseRec.consoleErrors.includes(e))
  add(
    name,
    'console error',
    newErrors.length === 0 ? 'PASS' : 'FAIL',
    `base=${baseRec.consoleErrors.length} after=${afterRec.consoleErrors.length}；新增=${newErrors.join(' / ') || '(无)'}`
  )

  // 2) UI 状态（消息数 / 按钮可用性 / 提示文案）
  for (const [capName, baseCap] of Object.entries(baseRec.captures)) {
    const afterCap = afterRec.captures[capName]
    if (!afterCap) {
      add(name, `状态 ${capName}`, 'FAIL', '改造后缺少该状态')
      continue
    }
    const keys = ['messageCount', 'bubbleCount', 'hasTextarea', 'sendButtonPresent', 'sendDisabled', 'modalOpen']
    for (const key of keys) {
      const same = JSON.stringify(baseCap.states[key]) === JSON.stringify(afterCap.states[key])
      add(name, `${capName}.${key}`, same ? 'PASS' : 'FAIL', `base=${JSON.stringify(baseCap.states[key])} after=${JSON.stringify(afterCap.states[key])}`)
    }
    const baseNotice = baseCap.states.noticeTexts.join(' | ')
    const afterNotice = afterCap.states.noticeTexts.join(' | ')
    add(name, `${capName}.提示文案`, baseNotice === afterNotice ? 'PASS' : 'DIFF', baseNotice === afterNotice ? baseNotice || '(无)' : `base="${baseNotice}" after="${afterNotice}"`)
  }

  // 3) DOM 结构摘要
  for (const [capName, baseCap] of Object.entries(baseRec.captures)) {
    const afterCap = afterRec.captures[capName]
    if (!afterCap) continue
    const d = diffLines(baseCap.digest, afterCap.digest)
    const expected = d.removed.filter((l) => /provider|model|服务/.test(l)).length
    const verdict = d.added.length + d.removed.length === 0 ? 'PASS' : 'DIFF'
    add(
      name,
      `${capName}.DOM 结构`,
      verdict,
      `+${d.added.length} / -${d.removed.length} 行；新增示例：${d.added.slice(0, 4).map((l) => l.trim()).join(' ; ') || '(无)'}${d.removed.length ? `；删除示例：${d.removed.slice(0, 3).map((l) => l.trim()).join(' ; ')}` : ''}${expected ? '' : ''}`
    )
  }

  // 4) localStorage 契约
  const storageKeys = [...new Set([...Object.keys(baseRec.captures).flatMap((c) => Object.keys(base.scenarios[name].captures[c].storage)), ...Object.keys(afterRec.captures).flatMap((c) => Object.keys(afterRec.captures[c].storage))])]
  for (const key of storageKeys) {
    const baseVals = [...new Set(Object.values(baseRec.captures).map((c) => JSON.stringify(c.storage[key] ?? null)))]
    const afterVals = [...new Set(Object.values(afterRec.captures).map((c) => JSON.stringify(c.storage[key] ?? null)))]
    const same = JSON.stringify(baseVals) === JSON.stringify(afterVals)
    add(name, `localStorage ${key}`, same ? 'PASS' : 'DIFF', same ? baseVals.join(' / ') : `base=${baseVals.join(' / ')} after=${afterVals.join(' / ')}`)
  }
}

// 5) 性能类观察项
for (const [name, baseRec] of Object.entries(base.scenarios)) {
  const afterRec = after.scenarios[name]
  if (!afterRec) continue
  for (const [i, step] of baseRec.steps.entries()) {
    const afterStep = afterRec.steps[i]
    if (!afterStep) continue
    const key = Object.keys(step).find((k) => k.endsWith('Ms') || k === 'ms')
    if (key && typeof step[key] === 'number') {
      const ratio = afterStep[key] / Math.max(step[key], 1)
      add(name, `耗时 ${step.step}.${key}`, 'INFO', `base=${step[key]}ms after=${afterStep[key]}ms ratio=${ratio.toFixed(2)}`)
    }
  }
}

const w = (v) => ({ PASS: 12, FAIL: 8, DIFF: 12, INFO: 8 })[v] ?? 8
console.log(rows.map((r) => `${r.verdict.padEnd(w(r.verdict))} | ${r.area} | ${r.item} | ${r.detail}`).join('\n'))
const fails = rows.filter((r) => r.verdict === 'FAIL')
const diffs = rows.filter((r) => r.verdict === 'DIFF')
console.log(`\n汇总：PASS=${rows.filter((r) => r.verdict === 'PASS').length} FAIL=${fails.length} DIFF=${diffs.length} INFO=${rows.filter((r) => r.verdict === 'INFO').length}`)
fs.writeFileSync(path.join(AFTER, 'diff.json'), JSON.stringify(rows, null, 1))
