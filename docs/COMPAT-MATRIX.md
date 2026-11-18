# 兼容性矩阵（低内核 WebView / AOSP 镜像）

> 归属 Issue：#10（已合并原 #3 / #5 范围）。关闭条件 = 四台（API 30/31/33/34）各自
> 真实版本 + 能力探测 + 首屏 + 反馈滚动 + 导入入口 + 系统信息真值，产出 `docs/compat/<api>*.json`
> 与关键截图，结论三分类；OEM 真机残余风险只记边界，不挂单。
>
> 当前进度：**API 30 与 API 31 已跑完**；API 33 / API 34 因发布构建占用 CPU/内存，
> 按资源协调要求暂停（见文末「未完成项」）。

## 1. 被测对象与矩阵为什么是这四个点

| 维度 | 取值 | 理由 |
| --- | --- | --- |
| 被测包 | worktree `/root/worktrees/deepseek-compat-matrix`，分支 `test/compat-matrix`，基于 `integration/next` tip `a2290c5`（13:57） | 必须测候选版本，不能拿旧包冒充 |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，`versionName=1.4.0-beta.7` `versionCode=14`，sha256 `c0abf1d914553346cc26cb522fae535cc703737b14d6d9875947a26edc200925` | 报告里带 hash，可复核 |
| API 30 | google_apis x86_64 r16 | 最老 WebView 内核（Chrome 83）+ 中国大存量 |
| API 31 | google_apis x86_64 r14 | 对齐真机反馈 FIN-AL60 / Android 12 |
| API 33 | google_apis x86_64 r17 | 对齐 ColorOS 13.1 / Reno6 底包，卡在 dvh（Chrome 108）边界 |
| API 34 | google_apis x86_64 r14（已装 test34 AVD） | 对照组：若 33 也挂、34 通过，才能说明是内核边界而不是产品 bug |

刻意跳过：API 32（与 31 差异小）、API 24–28（存量小、镜像难找、收益低）。

## 2. 运行方式（可复现）

```bash
# 1) 一台一台来：建 AVD（2 core / 540x1200 / dpi240 / swiftshader_indirect，形状对齐 test34）
#    镜像已装：
#    sdkmanager --sdk_root=/root/android-sdk --install \
#      "system-images;android-30;google_apis;x86_64" \
#      "system-images;android-31;google_apis;x86_64" \
#      "system-images;android-33;google_apis;x86_64"

# 2) 启动（自带内存守卫：MemAvailable<6GiB 拒启、运行中<2GiB 立即停本轮、独立 slice）
bash tests/device/avd-boot.sh compat31          # 开机后用 --stop 收尾
# 3) 跑矩阵（同一组检查）
node tests/device/compat-matrix.mjs --api 31 --avd compat31
# 4) 收尾：立刻停 AVD 释放 scope
bash tests/device/avd-boot.sh --stop compat31
```

宿主内存真相（踩过两次 OOM，写进脚本不要改）：
- emulator 会**强制提升 guest RAM**：`hw.ramSize=1280` 无效，日志出现 `Increasing RAM size to 2048MB`；
  因此预算按「实际强制值 + 余量」算，绝不假设 1280。
- 余量 **800M 不够**：API31 的 scope 在 `2048+800=2848M` 被 cgroup OOM 杀掉
  （`memory.events oom_kill=1`，`anon-rss 2.89G`）。现默认 `HEADROOM_MIB=1200`（2048+1200=3248M）后稳定。
- 绝不放进 `dsh-heavy.slice`（`MemoryMax=4G` 共享父限额，会和 Gradle/rspack 互相连坐）。

## 3. 检查项（同一组，四台都跑）

1. **设备真值**：`getprop ro.build.version.release/sdk/flavor/product.cpu.abi` +
   `dumpsys webviewupdate`（provider + version + Multiprocess + preferred）。
   `dumpsys` 里**没有**字面量 `webview_implementation` 字段，报告按「包名 + multiprocess + 版本」记录，不臆造。
2. **产物静态分析**：扫 `dist/static/js/main.*.js` 里超出内核的语法/API（`||=`/`&&=`/`??=`、
   `Object.hasOwn`、`.at()`、`.toSorted()`、`structuredClone`、`100dvh`、类静态块、私有字段），
   并记录 rspack `targets`（当前 `chrome >= 105`）——白屏到底是「解析不了」还是「运行时缺 API」，靠这一项分开。
3. **能力探测**（页面内 typeof/实测，不用 UA 猜）：`toSorted/toReversed/toSpliced/with`、
   `Object.hasOwn`、`Array.at`、`structuredClone`、`fetch`、`AbortController`、`ResizeObserver`、
   `visualViewport`、`TextDecoder`、`CSS.supports('height','100dvh')`；UA 只做交叉校验，
   且要求 UA 内核版本与 `dumpsys` 一致，否则 UA 不可信。
4. **首屏**：先 `Page.reload` 再判定，抓加载期异常、DOM 节点数、文本长度、`textarea` 占位符、
   欢迎页文案（中英都认）。白屏必须给原因（异常 + 缺能力复现 + logcat 佐证），不能只写「白屏」。
5. **反馈弹窗**：真点开 → 找最大可滚动盒子 → **真触摸**上滑到尾部、下滑回首部
   （先 `Input.dispatchTouchEvent`，页面没收到触摸事件/没滚动就回落 `adb shell input swipe`，
   报告记录实际通道）+ 首尾截图；保存日志按钮可见未禁用；取消后重开是否保留表单；
   软键盘遮挡用「视口压矮 42% + 真实重排」模拟（**simulated=true，不是真 IME**）。
6. **导入入口**（Issue #9 旧内核基线）：设置 → 数据管理 → 「从链接导入」→ 填 URL（空串时按钮
   disabled 属正常，填后才可点）→ 点导入 → 覆盖确认 → 观察阶段事件（下载中 / 正在导入 / 已导入）
   是否走通、会话数是否落库。用本地 mock zip（`http://10.0.2.2:5231`），**不连真实用户链接**。
7. **系统信息真值**（Issue #5，产出 `<api>-systeminfo.json`）：
   - 原生插件 `DiagnosticsDevice.snapshot()` 与 getprop/dumpsys/`settings get system font_scale` 逐字段比对；
   - 在页面里拦截 Capacitor `nativePromise` 桥，让 `ExportText` 的分块写入落到内存里，
     从而拿到**「保存日志文件」实际会写盘的 JSON 全文**（不开 SAF 选择器），校验
     `device.androidVersion / webviewVersion / system.androidSdk / androidRelease / webviewPackage /
     webviewVersion / fontScale / nativePath / capabilities`；
   - fallback 验证：用 `Page.addScriptToEvaluateOnNewDocument` 让 `DiagnosticsDevice.snapshot` 必抛，
     确认 App 仍渲染、弹窗仍可开、导出仍产出合法 JSON（降级不阻塞），并记录降级下缺哪些字段。
   - **上传链路刻意不点「提交」**：见下节事故记录。
8. **大字体 1.3 / 1.5**：`settings put system font_scale` → 重启 App → 反馈弹窗里提交按钮是否仍可达
   （位置可达/无溢出，`disabled=true` 只记录不算失败）。
9. **logcat**：`FATAL EXCEPTION` / `ANR in com.example.deepseekchat` 必须为 0。

## 4. 结论（三分类）

| API | 内核 | 结论 | 依据 |
| --- | --- | --- | --- |
| 30 | Android 11 / WebView 83.0.4103.106 | **该内核确实失败（首屏白屏）** | 见 4.1 |
| 31 | Android 12 / WebView 91.0.4472.114 | **部分可用但存在硬失败**（首屏 OK；弹窗内手势滚动、取消保留表单、URL 导入走到 staging 失败） | 见 4.2 |
| 33 | — | 未覆盖（暂停中） | 资源协调 |
| 34 | — | 未覆盖（暂停中，作对照组） | 资源协调 |

### 4.1 API 30 = 白屏，且是「解析级」不兼容

- 页面 12 个 DOM 节点、`innerText` 长度 0、body 纯白、无 `textarea` → 首屏完全没渲染（非慢加载，reload 后一致）。
- `Runtime.exceptionThrown`：`SyntaxError: Unexpected token '='`；
  logcat：`Capacitor: JavaScript Error: {"type":"js.error",...,"url":".../static/js/main.f7d49f79.js","line":1,"col":232976}`。
- 产物静态分析：rspack `targets = chrome >= 105`；产物里 4 处超出 Chrome 83 —
  `||=`/`&&=`/`??=`（需 85，@29345，即解析失败位置附近）、`Object.hasOwn`（需 93）、`.at()`（需 92）、`100dvh`（需 108）。
- 能力探测实测全 false：`toSorted/toReversed/toSpliced/with/hasOwn/at/structuredClone/dvh`；
  页面内复现 `Object.hasOwn({},'a')` → `TypeError: Object.hasOwn is not a function`、`[].at(-1)` → `TypeError: [].at is not a function`。
- logcat 无 FATAL/ANR —— 是**静默白屏**，不是崩溃，用户侧表现为「打开就是白屏」。
- 因此 UI 类检查（反馈/导入/系统信息/大字体）在 API30 一律记 `未覆盖/不可判定`（前置不成立），没有写成失败。

**一句话**：不是某个功能降级，而是 bundle 在 Chrome 83 上连解析都过不去；最低要求被锁在 Chrome 105 基线
（`||=` 只是最先撞上的一个，`.at()`/`Object.hasOwn` 修好也仍然过不了 83）。

### 4.2 API 31 = 能用，但有三处硬失败（需 API33/34 对照才能定性）

- 首屏正常（150 节点 / 851 字符 / `textarea` 占位符 `Enter a message`），能力探测与内核预期完全吻合
  （91：`hasOwn/at/toSorted/structuredClone/dvh` 全 false，`fetch/ResizeObserver/visualViewport/TextDecoder` 有）。
- 反馈弹窗能开，保存日志按钮可达；**大字体 1.3/1.5 下提交按钮仍可达**（视口 360x728，rootFont 20.8/24px），
  视口压矮 306px 模拟键盘 inset 后按钮 `top=344 bottom=384` 仍在 422px 视口内。
- 系统信息真值：原生插件 8 项全对（`androidRelease=12`、`androidSdk=31`、`webviewPackage/Version` 与 dumpsys 一致、
  `fontScale` 与 settings 一致、`model=sdk_gphone64_x86_64`）；导出 JSON 的 `device.system.*` 与 `capabilities`
  逐项对齐（`{"toSorted":false,"hasOwn":false,"at":false,"visualViewport":true,"dvh":false}`）；
  fallback（强制原生快照失败）下 App 不白屏、弹窗可开、导出仍合法（`nativePath=unavailable`，UA 派生
  `androidVersion=12`/`webviewVersion=91.0.4472.114` 仍在，`androidSdk`/`fontScale` 缺失属已知降级）。
- **失败 1**：弹窗内「首部→尾部」手势滚动不生效：`scrollTop` 恒 0（内容 2034 / 可视 528），
  CDP 触摸事件确实到达页面（`touchstart=5/touchmove=15/touchend=5`），回落 `adb shell input swipe` 仍不动
  → 手势被吞（布局层面 `overflow`/命中区域可疑），截图见 `shots/31-feedback-*.png`。
- **失败 2**：取消后重新打开，问题描述被清空（`写入=compat-matrix 表单保留自测`，`重开值=''`）。
  注意：产品文案只承诺「取消**保存文件**时保留表单」（`feedbackExportCancelled`），关闭弹窗是否应保留需产品确认，
  这里按实测记失败，不臆断为缺陷。
- **失败 3**：URL 导入阶段事件走到 `download 200 OK → check → staging` 后在 staging 抛
  `BackupError: 文件内容不完整`（`import_error ... at staging`，999ms），会话数 0/8，界面给出错误提示、
  未崩溃、未白屏。是否为本内核特有（如 inflate/流式读取边界）**需 API 33/34 用同一 mock 包对照**才能定性，
  现在不能写成「该内核特有的导入 bug」。

### 4.3 事故记录（必须留痕）

在 15:03 的一轮里，脚本点了反馈弹窗的「提交」，本以为页面级 `fetch` 拦截能兜住，但
**Android WebView 下 Capacitor 把 `window.fetch` 劫持到原生 `CapacitorHttp` 插件**，
页面级拦截既拿不到 body 也拦不住请求 —— logcat 可见
`pluginId: CapacitorHttp, methodName: post, url: http://62.106.70.167:60012/feedback`，
内容是自测文本「compat-matrix 硬件矩阵自测，请忽略」+ device 头行（机型/Android 12/WebView 91）+ 本地诊断日志
（不含对话内容、API Key、联系方式、client id 之外的私密数据；`log` 由采集层脱敏）。

处置：已从矩阵脚本**彻底删除「点提交」步骤**（不再触发任何真实上传），上传链路改由 integration 层
mock transport 覆盖；报告里该检查项固定为 `skip` 并写明原因。若后端能看到这条测试工单，请忽略/删除。

## 5. 边界（真机残余风险，只记边界不挂单）

- AOSP `google_apis` 镜像 ≠ ColorOS 13.1 / MagicOS 等 OEM 真机：OEM WebView 版本独立、输入法（尤其国产输入法
  的 `windowSoftInputMode` 与 inset 行为）、系统字体档位（字体+显示大小组合）都不同，需真机复测。
- 软键盘遮挡检查是「视口压矮模拟」，`simulated=true`；真 IME 弹出/收起时序、`adjustResize` vs `adjustPan`
  仍需真机。
- `fontScale` 用 `system.font_scale` 设置，等价于系统字体放大，但不等价于 OEM 的显示大小缩放组合。
- 高刷/GPU/SwiftShader 差异：模拟器全用 `swiftshader_indirect`，滚动性能与掉帧不代表真机。

## 6. 未完成项 / 待命

1. API 33（Google APIs x86_64 r17）与 API 34（test34 对照组）两台矩阵**未跑**：
   发布构建（beta.8 Gradle）占用资源，按协调暂停，等窗口恢复。
2. API 31 的 3 处硬失败需要 33/34 对照 → 才能出「该内核特有的失败」还是「产品 bug」的最终分类。
3. API 30 若用低内核修复分支的包重测，本套脚本可原样复用（`--api 30 --avd compat30`）。

## 7. 产物

```
docs/compat/30.json            # API30 全量检查 + 判定 + 截图清单
docs/compat/31.json            # API31 全量检查 + 判定 + 截图清单
docs/compat/31-systeminfo.json # Issue #5 系统信息真值（原生/导出 JSON/UA 交叉/fallback）
docs/compat/shots/*.png        # 关键截图（绝对路径见 30.json / 31.json 的 screenshots 字段）
tests/device/compat-matrix.mjs # 矩阵脚本（低层 CDP，不用 Playwright 高层 CDP）
tests/device/avd-boot.sh       # 单台串行启动器（内存守卫 + 按真实强制 RAM 算预算）
```
