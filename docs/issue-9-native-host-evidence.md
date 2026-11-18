# Issue #9 — native 下载事件 host focused 证据

日期：2026-11-18（Asia/Shanghai）。基线：`integration/next` / `a2290c5e9c84d7b6b015ed413499ba5712eb3c1e`。
独立分支 `test/issue9-native-evidence`，worktree `/root/worktrees/deepseek-issue9-native`。

## 真实反馈边界

来源：GitHub #9 已有父代理脱敏摘录（https://github.com/zzy-repo/deepseek-app/issues/9#issuecomment-6970399108）。

- PLA110 / Android 16 / WebView 155 / beta.7，工单短 id `8e6df485`：13:34:51 `import_start` / download 后约 44s 无终态；有 11.1s longtask。仅支持下载阶段停滞，不支持解析/写库因果结论。
- FIN-AL60 / Android 12 / WebView 114：缺导入入口与 `import_start`，不作为导入卡死复现。
- 检查时 #9 未提供包含 `a2290c5` 新 native 事件口径的 PLA110 新日志。本次不读取工单管理端或用户秘密，不连接设备、不启动 AVD、不发版。

## 本次交付与结果

新增 `tests/integration/url-import-native-events.test.mjs`：使用已有 host Playwright / 静态服务 / Capacitor bridge fixture 模式，应用代码和 diagnostics collector / `buildLegacyLog` 均为真实候选构建。外部浏览器请求全部阻断。URL、Key、签名只用合成标记。

- **21 assertions PASS**：begin / response / error / watchdog 在 snapshot JSON 和实际 legacy log 中保留；from/span/attempt/status/elapsedMs 可见；合成 Signature、AccessKeyId、token、Bearer Key 原文均不出现。
- 首块传递 `connectTimeout=10000`、`readTimeout=12000`、`Range=bytes=0-4095`。
- 成功响应后 watchdog 清除，快响应未留下虚假静默事件。
- fixture 主动在 connectTimeout + readTimeout 后 reject：t=15s watchdog，t=22s error，t=22.3s 第二次请求（`bytes=0-2047`），t=37.3s 第二次 watchdog，t=44.3s error + `import_error(reason=timeout)`。总 duration 含少量入口耗时，本次为 44307ms。
- 永不 resolve/reject 的 native Promise fixture：推进到 **120s**，仍只有一个请求、没有 retry、没有 import_error；最后 import 事件如下。

```json
{"kind":"import_stage","level":"info","msg":"import: native request silent >15s","meta":{"stage":"download","request.from":0,"request.span":4096,"attempt":0,"elapsedMs":15000}}
```

### 对旧 Issue 推断的纠正

**44.3s 是 fixture 主动按 22s 拒绝的模型路径，不是真实 native 硬上界。** JavaScript 调用仅透传 connect/read 参数，并未设置 Promise 总时限；重试依赖 reject。Android 依赖源码 `@capacitor/android@8.6.2` 的 HttpRequestHandler 将参数传给 HttpURLConnection 的 connect/read timeout 后执行 connect/buildResponse，没有在此 JavaScript 链路建立总 wall-clock deadline。readTimeout 是读间隔而非整包总时限，持续有字节的慢响应也可能超过 22s。

**当前 watchdog 每 attempt 只 setTimeout 一次，15s 记录但不中止，不是每 15s heartbeat。** host fixture 证明若桥 Promise 永久 pending，应用同样永久 await 的控制流缺口；它不证明真实 PLA110 / CapacitorHttp 已出现此行为。也不要把“无 watchdog”单独当作主线程停摆的充分证据，生命周期、日志保留和版本口径都应核对。

本次 response 埋点含 status/elapsedMs，不含 response bytes；下载累计字节来自后续真实 progress/trace，避免宣称已有原生响应字节字段。

## 重跑

```sh
# 在独立 worktree 中；先确认 dist 是本候选构建
pnpm build
node tests/run-layer.mjs integration --only url-import-native-events --json /tmp/issue9-focused.json
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/oxlint/bin/oxlint src rspack.config.ts
git diff --check

# 自有随机 loopback 静态服务上的已有 stage 回归，退出后关闭服务
node --input-type=module -e 'import {serveDist} from "./tests/helpers/runtime.mjs"; import {spawn} from "node:child_process"; const s=await serveDist("dist"); try { const c=spawn(process.execPath,["tests/run-layer.mjs","integration","--only","url-import-stages"],{stdio:"inherit",env:{...process.env,APP_URL:s.url}}); process.exitCode=await new Promise(r=>c.on("close",r)); } finally {await s.close()}'
```

stage 回归 PASS（79 条断言），构建一致 `main.f7d49f79.js`；type PASS；lint 0 errors / 0 warnings；diff check PASS。初次 focused 运行因首次进入页面已打开设置弹窗而失败，测试增加 dialog guard 后重跑通过。pnpm script 使用共享 node_modules symlink 时有前置安装器警告，实际编译成功；再次直接执行 tsc / oxlint 均正常退出。

## 状态与恢复动作

Issue #9 保持 OPEN，标签改 `status:blocked`：缺 PLA110 含新 native 事件的同口径日志；host 测试交付不是修复或真机结案。

恢复：由现有反馈渠道取得 PLA110 同档位、含 a2290c5 埋点版本的一次重新操作诊断导出（不传真实 Key / 完整签名 URL；本任务不发版）。包括确认点击前后、import_start、native begin/response/error/watchdog、至少 120s 或终态窗口、longtask/生命周期/设备 facts。用开始时间及事件序列对齐该次操作，核对版本；若 begin 后仅 watchdog，继续定位桥/原生未返回与生命周期；若 error/retry，核实际间隔；若 response 后停滞，再追 decode/ZIP/staging/IDB。缺该日志时保持 blocked，不空等、不宣称已修复、不关闭 #1。
