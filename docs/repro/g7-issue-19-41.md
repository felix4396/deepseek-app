# G7 · #19 集成测试基线假红排查 + #41 断流/慢首 token 反馈缺失

执行环境（均为本机真实运行，无一处是推测）：

- 仓库：`D:\all_project\deepseekapp`，`main` @ `b7b5750`（1.4.0-beta.8）
- 隔离 worktree：`/d/all_project/runs/g7`（detached HEAD `b7b5750`），所有构建/测试只在此目录，主工作区未改动、未提交、未推送
- Node `v22.23.2`，pnpm `12.21.0`，Playwright `1.64.1`（chromium_headless_shell-1248）
- 产物：`dist`（标准）、`dist-standard`、`dist-internal`（`INTERNAL_BUILD=1`）、`dist-scroll`；`dist-baseline` **未**构建
- 代理全部 `unset`（`http_proxy/https_proxy/HTTP_PROXY/HTTPS_PROXY`），否则上游桩与本地静态服务都被代理劫持

---

## 一、#19：integration 层真实基线

### 复现命令（原文可复制执行）

```bash
cd /d/all_project/runs/g7
export PATH=/d/all_project/runs/g7/_scratch/bin:$PATH   # 见 §1.4 的 python3 解释器问题
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
APP_URL=http://127.0.0.1:5301 \
DIST_DIR=$PWD/dist-internal STANDARD_DIST_DIR=$PWD/dist-standard DIST_DIR_STANDARD=$PWD/dist-standard \
node tests/run-layer.mjs integration --timeout-ms 300000 --json _scratch/integration-result.json
```

### 原始输出（汇总）

```json
{ "version":1, "totalMs":374581, "selected":24, "executed":24, "passed":15, "failed":9 }
```

即 **24 个文件 → 15 绿 / 9 红**。Issue 正文的「21 文件 / 13 红」与 owner 修正的「20 文件 / 7 红」都与本轮不符（文件数已涨到 24），下面按本轮真实红名单逐条定性。

### 1.1 七（九）个红文件的定性表

| # | 失败文件 | 结论 | 原始证据（截断，逐字来自 `_scratch/integration-result.json`） | 根因 file:line |
|---|---|---|---|---|
| 1 | `feedback-export.test.mjs` | **假红** | `AssertionError: The input did not match /deepseek-feedback-.*v1\.4\.0-beta\.6\.json$/ Input: 'deepseek-feedback-2026-11-18T09-46-09-207Z-v1.4.0-beta.8.json'` | 测试把版本号写死：`tests/integration/feedback-export.test.mjs:46`；产品侧版本是 `package.json:3` = `1.4.0-beta.8` |
| 2 | `feedback-scroll.test.mjs` | **假红** | `Error: ENOENT: no such file or directory, mkdir 'D:\D:\all_project\runs\g7\docs\ui\feedback-scroll'` | `new URL('../../docs/ui/feedback-scroll/', import.meta.url).pathname` = `/D:/...`，在 Windows 上拼出 `D:\D:\...`：`tests/integration/feedback-scroll.test.mjs:6`；另需 `dist-scroll`（`:8`，本轮未构建） |
| 3 | `diagnostics-contract.test.mjs` | **[A] 真红** / **[B] 假红** | [A] `import_error: {"kind":"import_error","level":"error","meta":{"stage":"download","durationMs":1,"reason":"forbidden","http.status":403,"download.bytes":0}}` → `✗ 字段不全`（缺 `url.path`、`error.msg`）。[B] 第一轮 `net_response: undefined`；改用 `dist-standard` 重跑后 `net_response: {"level":"error","http.status":502,"durationMs":5,"bytes":69,"url.path":"/anthropic/v1/messages"}` 到位 | [A] `src/services/chat/history/urlImport.ts:320-330` `recordDownloadFailure()` 只写 `stage/durationMs/reason/extra/errorMeta(error)`，native 403 分支既没 `url.path` 也没有 error 对象 → `error.msg` 也空。[B] 我给 `DIST_DIR=dist-internal`，内测包走 `/v1/chat/completions`（`src/services/api/providers.ts:174-177`），而桩打在 `**/v1/messages`（`tests/integration/diagnostics-contract.test.mjs:158`）→ 产物类别错，非产品问题 |
| 4 | `full-acceptance.test.mjs` | **假红** | `用例异常：Error: ENOENT: no such file or directory, open 'D:\root\deepseek-app\docs\acceptance\1.3.0-translator-unit.log'` | 测试把 Linux 绝对路径写死：`tests/integration/full-acceptance.test.mjs:355`；前面 30 余条功能断言全 `ok` |
| 5 | `mode-switch-plain.test.mjs` | **假红** | `page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:5191/` | 需要 `PLAIN_URL`(5191)+`BASELINE_URL`(5192) 两套产物两台静态服务：`tests/integration/mode-switch-plain.test.mjs:10-11,:60`；本轮只起了 5301 |
| 6 | `mode-switch.test.mjs` | **假红** | `locator.waitFor: Timeout 20000ms exceeded` waiting for `getByText('模式切换验收回复，逐字流出。')`（`...:324`）；此前 `ok 3 次切换后选中态与计算样式始终一致` | 桩仍打在旧上游：`context.route` 拦 `http://123.207.199.196:60010/**` 且只认 `url.pathname.endsWith('/messages')`（`:6,:171,:191`），断言也要求 `endsWith('/v1/messages')`（`:326`）；产品默认已改 `62.106.70.167:60010` + `/v1/chat/completions` + `Authorization: Bearer`（`src/services/api/providers.ts:174-177`）→ 桩不命中，回复永不到达 |
| 7 | `motion.test.mjs` | **假红** | ①`✗ 消息流组件相对 68f9342 有改动：ChatInput.module.css \| CopyButton.tsx 2 files changed` ②`用例异常：locator.waitFor: Timeout 15000ms exceeded` waiting for `getByText('动效验收用的')` | ①基线 commit 写死 `MOTION_BASE \|\| '68f9342'`（`:37`）并断言 `src/components/messages`+`chatInput` 相对它零 diff（`:264-271`）——`CopyButton.tsx` 正是 #41 计划内改动，基线漂移 ②同一陈旧上游桩 `http://123.207.199.196:60010/**`（`:308`），与 6 同因 |
| 8 | `url-import-native.test.mjs` | **假红** | 12 条功能断言全 `✓`（原生桥、IndexedDB sessions=1、staging 已清空…）后 `Error: ENOENT ... open 'D:\D:\all_project\runs\g7\docs\ui\1.4.0-beta.2-url-import-native.png'` | `const SHOT_DIR = new URL('../../docs/ui/', import.meta.url).pathname`（`:15`）→ `:202` 截图路径非法 |
| 9 | `url-import-web.test.mjs` | **假红** | 5 条功能断言全 `✓`（`URL 输入框数量 = 0`、`提示「网页版无法直接下载导出链接…」` 等）后 `ENOENT ... 'D:\D:\...url-import-web.png'` | 同 8：`SHOT_DIR`（`:10`）→ `:85` |

### 1.2 Issue #19 点名的 7 个失败，与本轮对照

| Issue #19 点名的失败文件 | 本轮结果 | 说明 |
|---|---|---|
| `feedback-export` | 红 | 版本号写死（`beta.6` vs `beta.8`）→ 假红 |
| `url-import-web` | 红 | Windows 截图路径 → 假红 |
| `mode-switch` | 红 | 旧上游桩 `123.207.199.196/v1/messages` → 假红 |
| `motion` | 红 | 旧上游桩 + 硬编码基线 `68f9342` → 假红 |
| `mode-switch-plain` | 红 | 缺 5191/5192 两套产物 → 假红 |
| `provider-channels` | **绿 PASS (16465ms)** | 产物 `dist-standard` 就位即绿；issue 里这条红是「旧 Anthropic 桩 + 旧上游断言」造成的，主分支现状已与桩对齐 |
| `internal-build` | **绿 PASS** | 需 `DIST_DIR=dist-internal`（`INTERNAL_BUILD=1`），给对产物即绿 |

**结论：点名的 7 个里 5 个在本轮复现，且这 5 个全部是假红；另 2 个（provider-channels、internal-build）在产物给对的情况下本来就是绿的。本轮全量 9 红里 8 个假红、1 个真红（仅 diagnostics-contract 的 [A] 一条断言）。**

### 1.3 假红的四个共同根因（不是 9 个 bug，是 4 类）

1. **POSIX 路径写死**（#2/#8/#9 + #1 的版本号、#4 的 `/root/...` 同类）：`new URL(...).pathname` / 字符串拼 `/root/deepseek-app/...` 在 Windows 上必然 ENOENT。影响面：4 个测试文件、产品零改动。
2. **上游协议迁移后测试桩没跟**（#6/#7 + issue 里的 provider-channels/internal-build）：旧 Anthropic `123.207.199.196:60010` + `/v1/messages` + `x-api-key` → 现为 `62.106.70.167:60010` + `/v1/chat/completions` + `Authorization: Bearer`。影响面：3 个测试文件的桩与断言。
3. **前置产物/服务靠人肉准备**（#5、#2 的 `dist-scroll`、#3[B] 的产物类别）：`tests/README.md` 写了依赖，但 harness 不校验，缺了就直接 FAIL 而不是 SKIP。
4. **硬编码基线 commit**（`motion` 的 `MOTION_BASE=68f9342`）：任何消息流改动都会误报 red。

### 1.4 环境层面额外发现（必须记档，否则复现不了）

- 所有自起静态服务的测试都 `spawn('python3', ...)`（`feedback-scroll:8`、`diagnostics:32,67`、`provider-channels:28,95`、`internal-build:35,76`、`motion:30,280`、`copy-limit:69`、`feedback-export:10`）。本机 `python3` 解析到 WindowsApps 存根（静默 exit 9009，curl `000`）→ **这些测试在干净 Windows 机器上 100% 环境红**，根因是测试写死 `python3` 而非 `sys.executable`/跨平台探测。
- 本轮用 `_scratch/bin/python3.exe`（真解释器 `C:\Users\gzb\.platformio\penv\Scripts\python.exe` 3.11.7 的副本）+ `_scratch/pyvenv.cfg`（`home = C:\Users\gzb\.platformio\python3`）绕过；`python3.cmd` 垫片无效（CreateProcess 先命中 `python3.exe` 存根，忽略 PATHEXT）。
- 5291/5292/5293 在 `diagnostics` 与 `provider-channels` 之间复用，串行跑没问题，并行跑会命中上一条残留服务（脏产物）。

### 1.5 #19 修复计划（按根因，含爆炸半径与回归命令）

| 根因 | 修法 | 爆炸半径 | 回归命令（转绿的命令） |
|---|---|---|---|
| POSIX 路径 | 统一 `fileURLToPath(new URL(...))`；版本号从 `package.json` 读（或正则放宽到 `v\d+\.\d+\.\d+[^/]*\.json$`）；Linux 绝对路径改 `path.join(ROOT, 'docs/acceptance', ...)` | `tests/integration/{feedback-scroll,url-import-native,url-import-web,feedback-export,full-acceptance}.test.mjs`；产品代码不动 | `node tests/run-layer.mjs integration --case tests/integration/url-import-web.test.mjs`（同法逐个 `--case`） |
| 陈旧上游桩 | 桩改 `**/v1/chat/completions`，断言 `Authorization: Bearer`、`deepseek-v4.1-flash`、URL 含 `62.106.70.167:60010` | `tests/integration/{mode-switch,motion}.test.mjs`；`provider-channels`/`internal-build` 已有正确范式可抄 | `node tests/run-layer.mjs integration --case tests/integration/mode-switch.test.mjs` |
| 硬编码基线 commit | `MOTION_BASE` 改为「本单开始前的固定 sha」并把 `CopyButton.tsx`/`ChatInput.module.css` 纳入白名单（#41 计划内改动），或直接删掉 diff 断言改为动效属性断言 | `tests/integration/motion.test.mjs` | `MOTION_BASE=b7b5750 node tests/run-layer.mjs integration --case tests/integration/motion.test.mjs` |
| 前置产物不校验 | harness 在跑前 `requireDist()` 并校验产物指纹（internal/standard/scroll/plain/baseline 各自标记），缺失时输出 `SKIP 缺产物` 而不是 FAIL；`python3` 改为可配置（`PYTHON` 环境变量 + 自动探测） | `tests/helpers/runtime.mjs`、`tests/run-layer.mjs`、`tests/README.md` | `node tests/run-layer.mjs integration --list` + 全量 `node tests/run-layer.mjs integration --timeout-ms 600000` |
| **真红**：导入失败日志缺字段 | `src/services/chat/history/urlImport.ts:320-330` `recordDownloadFailure()` 补 `'url.path': safePathname(url)`、非 2xx 分支补 `error.msg: 'HTTP 403 Forbidden'`（该函数把 url 参数命名成 `_url` 直接丢了，改成真用即可） | 只影响诊断日志 schema（诊断面板/上报字段），不动导入业务分支；若有字段清单文档需同步 | `DIST_DIR=$PWD/dist-standard STANDARD_DIST_DIR=$PWD/dist-standard node tests/run-layer.mjs integration --case tests/integration/diagnostics-contract.test.mjs` |

### 1.6 未测边界（明确没做）

- `e2e/real-upstream` 未跑：需要 `E2E_API_KEY`，真实上游 p99 21.8s / 单次 91s 的链路本报告任何一条都没覆盖。
- `dist-baseline` 未构建，`mode-switch-plain` 只到「缺前置 → 红」，没有两套产物的对比结论。
- `feedback-scroll` 的真实滚动性能（README 标注实跑 191–200s）未跑，本轮它第 7 行就 ENOENT。
- 结论只在 Windows 11 + 本机 pnpm store 成立；同一套测试在 Linux CI 上是否同样红未验证（`python3` 与路径两类问题在 Linux 上是相反的假绿）。

---

## 二、#41：慢首 token 无阶段性反馈 + 断流/英文错误文案

### 复现命令

```bash
cd /d/all_project/runs/g7
export PATH=/d/all_project/runs/g7/_scratch/bin:$PATH
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
# 静态服务已起：python3 -m http.server 5301 --bind 127.0.0.1 --directory dist
APP_URL=http://127.0.0.1:5301 HOLD_MS=95000 node _scratch/g41-repro.mjs
```

`_scratch/g41-repro.mjs` 用 Playwright `page.route` 打四种桩：慢首 token（挂 95s 再吐 SSE）、缺 `message_stop` 的断流、流内英文错误帧、`route.abort('connectionfailed')` 断网。

### A 慢首 token 95 秒：UI 全程只有三个点（无阶段/无计时/无取消）

```
[slow] t=3000ms   dots=3 alerts=[] text~"新对话你好 深度思考智能搜索内容由 AI 生成，请仔细甄别"
[slow] t=15000ms  dots=3 alerts=[] text~"新对话你好 …"
[slow] t=45000ms  dots=3 alerts=[] text~"新对话你好 …"
[slow] t=90000ms  dots=3 alerts=[] text~"新对话你好 …"
[slow] t=97000ms  dots=0 alerts=[] text~"新对话你好慢首 token 之后到达的正文。 …"
```

95 秒里 `alerts` 恒空、`dots` 恒 3，文案一字未变（截图 `_scratch/g41/slow-3000ms.png` … `slow-90000ms.png`、`slow-final.png`）。**真红（产品缺陷）**，不是环境问题：上游是本地桩，准点 95s 才回。

根因 `file:line`：

- `src/components/messages/AssistantMessage.tsx:57` `const waiting = streaming && view.steps.length === 0 && !view.answer && !message.thinking`
- `src/components/messages/AssistantMessage.tsx:76-80` 等待态只渲染三个 `<span className={styles.waitingDot}/>`：无文案、无已等待秒数、无取消入口
- 无首字节看门狗：全仓只有探测接口有超时（`src/services/api/client.ts:340-357`，`timeoutMs = 15000`），chat 流没有
- 状态机本已区分该态：`src/services/chat/types.ts:66-72` 的 `ReplyStatus = 'pending' | 'streaming' | …`（`pending` = 请求已发出但还没有事件），UI 完全没用

### B 流中间断（无 `message_stop`）：一句提示都没有

```
[break] dots=0 alerts=[] text~"新对话你好断流前已经收到的半句 …"
[break] 可见按钮=["收起边栏","开启新对话","更多","设置","复制","编辑消息","复制","朗读","重新生成",…]
```

用户看到半句话停住，`alerts` 为空，只能自己发现「重新生成」（截图 `_scratch/g41/break.png`）。**真红（产品缺陷）。**

根因 `file:line`：

- `src/services/api/client.ts:318` `throw new ApiError('interrupted', '')` —— 消息体故意留空
- `src/services/chat/describe.ts` `describeReply()` 兜底 `message ? { text: message } : null` → 空串 → `null`
- `src/components/messages/AssistantMessage.tsx:49` `const notice = streaming ? null : describeReply(message)` → `null` → 提示块不渲染

### C 流内英文错误帧原样透出（"network error"）

```
[english-frame] alerts=["network error"] text~"新对话你好已经输出的部分network error …"
```

**真红（产品缺陷）**，正是 issue 截图的形状。

根因 `file:line`：

- `src/services/api/client.ts:303` `throw new ApiError('stream', payload.error.message)` —— 上游英文 `message` 直接进 ApiError
- 分类器只认 network / 401 / 402 / 429 / ≥500（`src/services/api/errors.ts:17-44`），`stream` 无 status → `'other'` → 兜底把 `message` 当 UI 文案原样渲染
- 对照：fetch 失败**已本地化**——`[offline] alerts=["网络异常，请检查你的网络状况"]`（`src/i18n/zh.ts:79`）。所以 issue 里「未本地化」的范围是**流内错误帧 + 断流**，不是 network 路径

### D 反证（避免误判）：`ui.notice:"unknown"` 是日志字段，不是 UI 文案

`src/services/chat/store.ts:1183-1200` 的 `record('error', …, {'ui.notice': …})` 中 `'unknown'`（`:1197`）只进诊断日志；`src/i18n/en.ts:174/177` 的 `importTraceReasonUnreachable/Network` 只用于内部 trace。按「UI 上出现 unknown」立论站不住，真正透英文的是 C。

### #41 修复计划

| 缺陷 | 修法 | 爆炸半径 | 回归命令 |
|---|---|---|---|
| A 慢首 token | `AssistantMessage.tsx:76-80` 接 `ReplyStatus==='pending'`（`types.ts:66`）+ 计时分级（3s / 10s / 20s 文案 + 已等待秒数）+ 取消按钮复用 `store.ts:104` 的 `AbortController`；新增 i18n key（zh/en 同步） | `AssistantMessage.tsx` + `i18n/{zh,en}.ts` + 其 module.css；不影响流式正文 | 新增 `tests/integration/stream-slow.test.mjs`（桩挂 12s，断言 t=4s 出现阶段文案与取消按钮） |
| B 断流无提示 | `client.ts:318` 保留 `interrupted` 这个 kind；`describe.ts` 加 `interrupted` 分支 → `replyStreamInterrupted`（「连接中断，已收到的内容保留」）+ 复用 `continueGenerating`（`AssistantMessage.tsx:142-190`）；兜底从 `null` 改为通用失败文案 | `describe.ts` + `client.ts` 分支归属 + i18n；诊断日志 `ui.notice` 取值由 `unknown` 变 `interrupted`（上报 schema 需知会） | 复用 `_scratch/g41-repro.mjs` 的 break 场景，断言 `alerts` 含中文断流提示 |
| C 英文透出 | `client.ts:303` 原文只进 diagnostics；UI 走 `classifyApiError` → 已分类用 i18n，未分类用 `replyStreamFailed`；禁止上游 `message` 直当 UI 文案 | `client.ts` + `describe.ts` + i18n；上报字段不变 | 复用 english-frame 场景，断言 `alerts` 不含 `network error` 且为中文 |
| D 无看门狗 | 给 chat 流加首字节预算（如 60s）→ 不直接失败，升级为 A 的「上游很慢，可等待/取消」；阈值对齐后端 p90 5.1s / p99 21.8s / max 32.4s | `client.ts` 流读取 + `store.ts` 状态机 | 慢首 token 桩改 90s：断言无英文报错、出现阶段文案 |

### #41 未测边界

- 真机 iOS/Android WebView 同一交互（只测桌面 Chromium 1280×800；issue 要的 390/360 截图未出）。
- 真实上游 750k–870k token 长上下文的慢首 token（无 `E2E_API_KEY`，未跑 `e2e/real-upstream`）。
- 「取消」按钮 + 后端 abort 后的落库一致性未验证（按钮尚不存在）。
- 断流后 `continueGenerating` 的真实续生成行为只确认按钮存在，未点。

---

## 三、证据清单

| 文件 | 内容 |
|---|---|
| `/d/all_project/runs/g7/_scratch/integration-run.log` | 全量 integration 逐文件 `>> / <<` 与逐条断言（24 文件） |
| `/d/all_project/runs/g7/_scratch/integration-result.json` | 结构化结果（15 passed / 9 failed，totalMs 374581） |
| `/d/all_project/runs/g7/_scratch/diag-contract-rerun.log` | `diagnostics-contract` 用 `dist-standard` 重跑（[B] 转绿、[A] 仍红）→ 真/假红分离依据 |
| `/d/all_project/runs/g7/_scratch/g41-repro.mjs` | #41 四场景复现脚本（route 桩，无任何真实 Key） |
| `/d/all_project/runs/g7/_scratch/g41-repro.log` | #41 原始控制台输出（本报告所有 `[slow]/[break]/[english-frame]/[offline]` 行） |
| `/d/all_project/runs/g7/_scratch/g41/*.png` | 9 张截图：`slow-3000ms/15000ms/45000ms/90000ms/97000ms/final.png`、`break.png`、`english-frame.png`、`offline.png` |
