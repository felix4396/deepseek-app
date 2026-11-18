# 端到端回归测试（Playwright）

## 真上游 + 真前端冒烟测试（**每次发版前必跑**）

```bash
cd /root/deepseek-app && E2E_API_KEY=sk-xxx node tests/e2e-real-upstream.spec.mjs
```

**为什么需要它**：此前 UI 用例全部用 `page.route` / mock 上游打桩，上游能力全部用 curl 验证，
两条线从未交叉——「真上游的 SSE 能不能被真前端解析并渲染成文字」这件事一直没有自动化覆盖。
发版前跑一次，等于给「真 key + 真 UI + 真上游」这条链路做一次完整握手。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `E2E_API_KEY` | （必填） | 只通过环境变量传，绝不写进文件 |
| `E2E_UPSTREAM_URL` | `http://123.207.199.196:60010` | 真上游地址 |
| `E2E_MODEL` | `deepseek-v4.1-flash` | 模型 |
| `E2E_APP_URL` | `http://100.113.135.55:5181` | 被测页面 |
| `E2E_ROUNDS` | `2` | 首轮冷启动 + 次轮热路径，同时作为 TTFT 基线 |

流程与断言：设置页**真实键盘输入** API Key → 保存（`chat-demo:api-key`）→ `GET {upstream}/v1/models`
前置探针（非 200 直接判「上游不可用」）→ 发「你好」→ 记录 **请求发出 / 首个字节(TTFB) / 界面首次出字 /
流结束** 四个时间点 → 断言助手文字长度 > 0、用户消息内容正确、流结束后 loading 消失、console error = 0
（浏览器对非 2xx 的资源日志另计）。

失败时按三层给证据，一眼区分是「上游没 flush / 格式不符」还是「前端没解析」：上游不可用（探针或
`/v1/messages` 非 200）/ 上游格式不兼容（有字节但没有非空 `text_delta`）/ 前端解析渲染问题（有
`text_delta` 但界面 0 字），并打印状态码、`Content-Type`、`Transfer-Encoding`、已收到的**原始 SSE 前 20 行**。

⚠️ 跑之前确认上游 IP 没被绑到本机回环（内测构建验收会 `ip addr add 123.207.199.196/32 dev lo` 把请求
打到 mock）。脚本会自检并直接失败；需要先 `ip addr del 123.207.199.196/32 dev lo`。同理，跑
`test.internal-build.spec.mjs` 前要把它加回来。

## 设置页「测试」按钮的鉴权


- `test.probe-auth.spec.mjs`：只在 API Key 输入框里填 key（**不点「确定」**）后点「测试」，断言 `/models` 请求的
  `Authorization` 头 === `Bearer <输入框里的 key>`。修复前该用例失败（发的是 `Bearer` 空鉴权），修复后通过。
- `test.probe-nokey.spec.mjs`：完全不填 key 时点「测试」，断言不发任何请求，并且界面给出「请先填写 API Key」。

依赖：任意可用的 playwright（1.64.x）。仓库里没有装，`tests/node_modules` 软链到已有的安装即可（已被 .gitignore 忽略）：

```bash
ln -sfn /root/bak/deepseek-web/node_modules /root/deepseek-app/tests/node_modules
```

跑法（被测页面由 http://100.113.135.55:5181 提供 `dist/`）：

```bash
cd /root/deepseek-app && node tests/test.probe-auth.spec.mjs && node tests/test.probe-nokey.spec.mjs
# 或：cd tests && node test.probe-auth.spec.mjs
# 自定义地址：APP_URL=http://127.0.0.1:5181 node tests/test.probe-auth.spec.mjs
```

## 内测构建（1.4.0-beta.1）的验收：两套构建分开跑

1.4.0 起有两种构建产物，spec 与它们一一对应：

| 构建 | 命令 | 覆盖的 spec |
| --- | --- | --- |
| 标准构建（默认，行为同 1.3.0） | `pnpm build` | 既有 9 个 spec（含三种服务类型 / 协议适配 / 旧配置兼容） |
| 内测构建（固定地址+模型，只留 API Key） | `INTERNAL_BUILD=1 pnpm build:internal` | `test.internal-build.spec.mjs` |

内测构建里「服务类型 / 服务地址 / 模型」三项不可编辑，所以那 9 个依赖切换服务类型、自填地址的用例只对标准构建有意义；
它们的断言一条都没有削弱，仍然逐字校验 deepseek / anthropic / openai 三条链路。

### 内测构建验收（自建，不依赖真实上游）

```bash
# 1) 把内测版固定的上游 IP 绑到本机回环，让请求真的打到本地 mock（root 权限）
ip addr add 123.207.199.196/32 dev lo

# 2) 构建内测包（dist 即内测产物）并跑验收：mock 上游 + 静态服务 + Playwright 都由脚本自己拉起
pnpm build:internal
cd tests && node test.internal-build.spec.mjs
```

`test.internal-build.spec.mjs` 断言：设置页没有 Service URL / Model 输入框、没有服务类型下拉、没有位置信息项，
只剩 API Key 输入框；发消息请求 URL 必须是 `http://123.207.199.196:60010/v1/messages`、`body.model` 必须是
`deepseek-v4.1-flash`、请求体不含 `safety_check`/`title`/`tools`/`role:'latest_reminder'`；固定项不落 localStorage；
console error = 0；并输出截图到 `docs/ui/1.4.0-beta.1-*.png`。

`mock-anthropic.mjs` 是 node 标准库实现的 mock 上游（默认监听 `123.207.199.196:60010`），回标准 Anthropic SSE，
并把收到的每个请求（含请求体）记到 `/tmp/mock-anthropic-requests.jsonl` 供断言。

## 会话自动标题验收（Anthropic / OpenAI 兼容模式）

```bash
cd /root/deepseek-app && node tests/test.auto-title.spec.mjs
```

被测页面是**标准构建**：脚本发现 `dist-standard/` 不存在时会自己用
`DIST_OUT=dist-standard rspack build` 构建（不会动部署用的 `dist/`），再在 5294 上起静态服务；
上游全部用 `page.route` 打桩，不连外网、不需要真实 IP。覆盖 9 条验收 + 2 条附加：

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | mock 返回「如何配置代理」 | 标题变成该值；标题请求只发 1 次；走 `{base}/v1/messages`、`max_tokens=32`、非流式、无 thinking、只喂首条消息且包成 JSON 数组 |
| 2 | mock 延迟 10s | 8s 放弃并回退为「这个网络问题怎么解决…」，期间 UI 可继续输入，迟到响应不覆盖 |
| 3 | HTTP 500 | 回退到同一截取值 |
| 4 | 返回空字符串 | 回退 |
| 5 | 脏输出 `**标题**\n解释…` | 只取「标题」（星号被剥掉） |
| 6 | `max_tokens` / `tool_use` | 视为失败并回退 |
| 7 | 手动改名后再发一轮 | 标题保持用户改的名字，且不再发起标题请求 |
| 8 | DeepSeek 官方模式 | 请求体仍带 `title:{enabled:true}`，无额外本地标题请求，标题保持为空 |
| 9 | console error | = 0（浏览器对非 2xx 的 `Failed to load resource` 资源日志另计，口径同 `run-acceptance.mjs`） |
| 10 | OpenAI 兼容模式 | 标题请求走 `{base}/v1/chat/completions`（system + 单条 user） |
| 11 | 部署验证 | 对 5181（`DEPLOY_URL` 可覆盖）再跑一遍成功路径，不可达则跳过 |

## 交互动效验收（1.4.0-beta.2）

```bash
cd /root/deepseek-app && node tests/test.motion.spec.mjs
```

覆盖外壳动效（侧边栏抽屉、设置弹窗、按钮按压、会话列表切项、主题切换），完全不涉及消息流：

- 中间帧：侧边栏 / 设置弹窗在 t=80/150/250ms 各截一张（`docs/ui/motion-*.png`），
  同时读 `getComputedStyle().transform` 的中间值，证明是渐变而不是瞬变
- 计算样式：侧边栏打开后 `transform = matrix(1, 0, 0, 1, 0, 0)`；关闭过程中 `tx < 0` 且 DOM 仍在（退出动画不被吞）
- reduced-motion：`page.emulateMedia({ reducedMotion: 'reduce' })` 下 `transition-duration = 1e-05s`、主题淡入 `animation: none`
- 静态检查：`src/` 下没有任何 `transition`/`animation` 动布局属性；相对基线提交 `68f9342` 没新增 `transform`/`opacity` 之外的动画属性
- 消息流冻结：`git diff 68f9342 -- src/components/messages src/components/chatInput` 必须为空
- 功能回归：侧边栏能点会话、设置能开能关、发消息正常（上游用 `page.route` 打桩，不需要真实 IP）

被测页面默认是 `dist/`（内测构建产物）上的独立静态服务（端口 5292），可用 `APP_URL` / `DIST_DIR` / `PORT` 覆盖。

## 「导入历史会话 → 从链接导入」（仅原生 APK）

目标 ZIP 在 DeepSeek 官方 OBS 桶上、未开 CORS，浏览器 fetch 必被拦，因此该能力只在原生端通过
`CapacitorHttp` 提供（`src/services/chat/history/urlImport.ts`）。三个 spec：

| spec | 覆盖 | 跑法 |
| --- | --- | --- |
| `test.url-import-native.spec.mjs` | mock 原生桥（`window.androidBridge` + `Capacitor.PluginHeaders` + `nativePromise`），7 个用例：ArrayBuffer 数据走完 `importHistory`、base64 数据（Android 实测形态）、非 ZIP、Content-Length > 200MB、下载中取消、网络失败、超时 | `node tests/test.url-import-native.spec.mjs`（需 5181 上的 dist） |
| `test.url-import-web.spec.mjs` | 网页端不渲染链接入口 + 提示替代做法；本地文件上传回归 | `node tests/test.url-import-web.spec.mjs` |
| `test.url-import-device.spec.mjs` | 真机/模拟器：`CapacitorHttp.get` 返回的 `data` 类型实测 + 真实 UI 导入（需要模拟器、`adb`、5199 上的导出 ZIP） | `node tests/test.url-import-device.spec.mjs` |

夹具 `archive-fixture.mjs` 用 fflate 生成最小导出 ZIP（manifest + 1 个会话 + index），格式与
`src/services/chat/history/format.ts` 对齐。断言口径：会话数取 IndexedDB `chat-demo/sessions`，
「走完链路」还要求 `sessionsStaging` / `filesStaging` 已清空（覆盖事务已提交）。

## 诊断日志与反馈上传（采集 / 上传解耦）

三个 spec 与 `src/services/diagnostics/` 一一对应。页面需带 `?diag-debug` 才会挂 `window.__diagnostics`
调试入口（正常使用不暴露），spec 通过它读日志、注入 mock transport、断言裁剪结果。

| spec | 覆盖 | 依赖 |
| --- | --- | --- |
| `test.diagnostics.spec.mjs` | 环形缓冲（500 条 + 30 分钟双限）、脱敏、截断、hook、transport 可替换、2MB 体积控制、UI 提交流程、`validatePayload` 自检、设置页「检查日志完整性」 | `pnpm build:internal`（dist） |
| `test.diagnostics-contract.spec.mjs` | 6 类故障注入的字段契约：导入 403 / 发消息 502 / 请求超时 / 未捕获异常 / 配置保存失败 / 长任务 | 自己构建 `dist-standard`（配置项可编辑） |
| `test.diagnostics-e2e.spec.mjs` | legacy 通道真实提交（`logSize` 回显）、`log` 字符串与 `content` 干净、150KB 裁剪 + `[truncated]`、连接重置后 50KB 降级重试、脱敏、413 可读提示 | 5181 已部署 + 能访问 `62.106.70.167:60012` |
| `diagnostics-blind-export.mjs` | 盲测取样：断网发消息 → 导出真正会发出的 body 到 `/tmp/feedback-blind.json` | 同上 |

```bash
cd /root/deepseek-app
pnpm build:internal && node tests/test.diagnostics.spec.mjs
node tests/test.diagnostics-contract.spec.mjs
node tests/test.diagnostics-e2e.spec.mjs      # 会真实提交到后端
node tests/diagnostics-blind-export.mjs        # 生成盲测样本（不发真后端）
```
