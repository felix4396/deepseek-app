// issue #39 原文举的例子：String.prototype.replaceAll 是 Chrome 85 才有的运行时 API，
// rspack 的 target=chrome83 只降语法、不补 API，legacy.ts 也没有它的补丁。
// 语法层完全看不见它（产物里没有 ||= / static {}），所以旧门禁 exit 0 —— 这就是关卡失效的硬证据。
const injected = (globalThis as unknown as { __FIXTURE_INPUT__?: string }).__FIXTURE_INPUT__
const input: string = injected ?? 'a,b'
console.log('[fixture:uncovered-replaceall] ->', input.replaceAll(',', '|'))
