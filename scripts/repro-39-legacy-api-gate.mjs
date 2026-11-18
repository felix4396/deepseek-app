#!/usr/bin/env node
// issue #39 红绿证据一键复现：check:legacy 拦不住「产物里有、目标运行时没有」的 ES2022 API。
//
//   node scripts/repro-39-legacy-api-gate.mjs            # 跑完自动删掉 .repro39 临时产物
//   node scripts/repro-39-legacy-api-gate.mjs --keep     # 保留 .repro39 便于人工翻产物
//
// 做四件事（全部是真跑，没有一条是打印出来的假结论）：
//   A. 用 rspack + chrome83 目标构建 4 个对照产物（scripts/fixtures/legacy-api-gate/*.ts）
//   B. 在「删掉 ES2022 内置 API」的进程里跑这些产物 —— 证明缺 API 时真抛 TypeError
//   C. 用 origin/main 上的旧 check-bundle-syntax.mjs 跑同一批产物 —— 证明它 exit 0（关卡失效）
//   D. 用当前（修复后）的 check-bundle-syntax.mjs 跑同一批产物 —— 证明该拦的拦住了
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildFixtures, ROOT } from './fixtures/legacy-api-gate/build-fixtures.mjs'

const KEEP = process.argv.includes('--keep')
const TMP = path.join(ROOT, '.repro39')
const RUNNER = path.join(ROOT, 'scripts', 'fixtures', 'legacy-api-gate', 'run-without-api.mjs')
const GATE = path.join(ROOT, 'scripts', 'check-bundle-syntax.mjs')

const node = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  return {
    code: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

/** 第一次出现的关键报错行（TypeError 之类的证据） */
const firstErrorLine = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /^\w*Error\b/.test(line) || line.startsWith('TypeError')) ?? ''

const expectations = []
const record = (label, actual, expected, detail) => {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  expectations.push({ label, ok, detail })
  return ok
}

console.log(
  `# issue #39 红绿复现（${path.relative(ROOT, ROOT) || '.'}，node ${process.version}）\n`
)

// ── A. 构建对照产物 ──────────────────────────────────────────────────────────
console.log('== A. 构建对照产物（rspack, target=browserslist(google chrome >= 83)）==')
const built = await buildFixtures(path.join(TMP, 'fixtures'))
for (const item of built) console.log(`   构建 ${item.name} -> ${path.relative(ROOT, item.dir)}`)
console.log('')

// ── B. 在缺 API 的运行时里跑产物 ─────────────────────────────────────────────
console.log('== B. 红证据：目标运行时缺 API 时，产物真抛错（不是断言，是真抛）==')
const bundleOf = (name) => path.join(TMP, 'fixtures', name, 'static', 'js', `${name}.js`)
const runtimeResults = {}
for (const name of [
  'clean',
  'covered-with-polyfill',
  'covered-without-polyfill',
  'uncovered-replaceall',
]) {
  const result = node([RUNNER, bundleOf(name)])
  runtimeResults[name] = result
  const line = firstErrorLine(result.out)
  console.log(
    `   [${name}] exit ${result.code}${line ? `  <- ${line}` : `  ${result.out.split('\n')[0] ?? ''}`}`
  )
}
record(
  '缺 Object.hasOwn/.at 的产物真抛错',
  runtimeResults['covered-without-polyfill'].code,
  (c) => c !== 0
)
record('缺 replaceAll 的产物真抛错', runtimeResults['uncovered-replaceall'].code, (c) => c !== 0)
record('带 polyfill 的产物在缺 API 环境里跑通', runtimeResults['covered-with-polyfill'].code, 0)
console.log('')

// ── C. 旧门禁（origin/main）对同一批产物的判定 ───────────────────────────────
console.log('== C. 红证据：origin/main 的 check:legacy 对上面的产物仍然 exit 0 ==')
// 放在仓库根下一层（<repo>/.repro39-old-gate/）：旧脚本用 dirname/.. 推导 ROOT，这样它算出来的
// ROOT 正好是仓库根，acorn 层、pnpm store 都能照常命中 —— 旧门禁是真跑的，不是被降级成纯词法才过的。
const OLD_GATE_DIR = path.join(ROOT, '.repro39-old-gate')
const oldGatePath = path.join(OLD_GATE_DIR, 'check-bundle-syntax.mjs')
mkdirSync(path.dirname(oldGatePath), { recursive: true })
let oldSource
try {
  oldSource = execFileSync('git', ['show', 'origin/main:scripts/check-bundle-syntax.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
} catch (error) {
  console.error(`   拿不到 origin/main 的旧脚本：${error.message}`)
  process.exit(1)
}
writeFileSync(oldGatePath, oldSource)
const oldGateResults = {}
for (const item of built) {
  const result = node([oldGatePath, item.dir])
  oldGateResults[item.name] = result
  const summary = result.out.split('\n').find((line) => line.startsWith('  JS 文件')) ?? ''
  console.log(`   [${item.name}] exit ${result.code} ${summary.trim()}`)
}
record(
  '旧门禁对「用了 replaceAll 的产物」exit 0（关卡失效）',
  oldGateResults['uncovered-replaceall'].code,
  0
)
record(
  '旧门禁对「polyfill 没进产物」exit 0（关卡失效）',
  oldGateResults['covered-without-polyfill'].code,
  0
)
console.log('')

// ── D. 新门禁（修复后）对同一批产物的判定 ────────────────────────────────────
console.log('== D. 绿证据：修复后的 check:legacy 该拦的拦、该放的放 ==')
const newGateResults = {}
for (const item of built) {
  const result = node([GATE, item.dir])
  newGateResults[item.name] = result
  const summary = result.out.split('\n').find((line) => line.startsWith('  运行时 API')) ?? ''
  const verdict = result.out.split('\n').find((line) => line.startsWith('结论')) ?? ''
  console.log(`   [${item.name}] exit ${result.code}`)
  if (summary) console.log(`     ${summary.trim()}`)
  if (verdict) console.log(`     ${verdict.trim()}`)
  for (const line of result.out.split('\n').filter((l) => l.trim().startsWith('✗'))) {
    console.log(`     ${line.trim()}`)
  }
}
record('新门禁拦住 replaceAll 产物', newGateResults['uncovered-replaceall'].code, 1)
record(
  '新门禁拦住「polyfill 没打进入口」的产物',
  newGateResults['covered-without-polyfill'].code,
  1
)
record('新门禁放行干净产物', newGateResults['clean'].code, 0)
record('新门禁放行「有 polyfill 兜底的裸调用」', newGateResults['covered-with-polyfill'].code, 0)
console.log('')

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = expectations.filter((item) => !item.ok)
for (const item of expectations) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}`)
if (!KEEP) {
  rmSync(TMP, { recursive: true, force: true })
  rmSync(OLD_GATE_DIR, { recursive: true, force: true })
} else {
  console.log(
    `\n临时产物保留在 ${path.relative(ROOT, TMP)} 与 ${path.relative(ROOT, OLD_GATE_DIR)}`
  )
}
if (failed.length) {
  console.error(`\n${failed.length} 条预期不成立，红绿证据不完整`)
  process.exit(1)
}
console.log('\n全部预期成立：旧门禁漏、新门禁拦，且缺 API 的产物在低内核运行时里真抛错')
