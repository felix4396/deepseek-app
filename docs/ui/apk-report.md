# APK 真机(Android 模拟器) UI 验证报告 — 1.2.3 / versionCode 6

1. KVM: `/dev/kvm` 存在, `kvm-ok` = usable, 8 vCPU → 真 KVM 加速(未用 -no-accel)。
2. 模拟器: AVD `test34` = android-34 / google_apis / x86_64, 1280M RAM, 540x1200@240dpi, `-gpu swiftshader_indirect`, headless。
   启动耗时 34s(`sys.boot_completed`)。首轮用 2048M+1080x2400 时打满 heavy-run 的 4 GiB slice, QEMU 线程挂死 → 降配后稳定。
3. Mock: 纯 stdlib python `:8899`, `GET /models` + `GET /v1/models`(app 实际请求 `/v1/models`), `OPTIONS`→204, `POST /v1/messages`→标准 Anthropic SSE(chunked, 每字 80ms)。app 内填 `http://10.0.2.2:8899`。
4. 验收:
   | 项 | 结果 | 截图 |
   |---|---|---|
   | app 启动不闪退 | PASS | apk-01-home.png |
   | 设置页打开 + 服务类型下拉可见 | PASS | apk-02-test.png |
   | Test 连通 10.0.2.2:8899 | **PASS** — "Connected (HTTP 200); 1 models: mock-model" | apk-02-test.png |
   | 发消息后看到 mock 回复 | **FAIL** | apk-03-send-opens-settings.png |
   | Anthropic 模式下搜索/附件/语音不可见 | PASS(仅剩 DeepThink) | apk-05-anthropic-home.png vs apk-01-home.png |
   | logcat 无 crash / unhandled error | PASS(仅 1 条非致命 JS error) | — |
5. 阻塞 #4 的真机 Bug: **API Key 不被持久化**。设置页 API Key 输入后 `localStorage["chat-demo:api-key"]` 始终为 null;
   每次点 Send 都重新弹出设置页、API Key 为空,且**不发任何请求**(mock 无记录)。预置该 localStorage 后重启,启动瞬间即被清空。
   —— 期间有 1 次 POST 真的到达 mock(同一对话框会话内 key 尚在内存时),证明客户端请求链路本身可用,SSE 也被接受。
6. logcat 关键信息(无 FATAL/ANR/am_kill):
   - `E Capacitor/Console: Error injecting safe area CSS: TypeError: Cannot read properties of null (reading 'style')` ×3(启动时,非致命)
   - `W Capacitor/Console: Mixed Content: ... requested an insecure resource 'http://10.0.2.2:8899/v1/models'` — 仅告警,请求实际成功(allowMixedContent=true 生效)
7. 工具限制: Maestro 装不上(`get.maestro.mobile.dev` / `github.com` 连接被重置),退化到 `adb shell input` + `screencap`。
   `adb shell input text "你好"` 抛 NullPointerException(adb 无法注入 CJK),且 app 忽略 CDP 注入的文本(state 不更新),
   故用户消息以 "hello" 输入(真实按键事件);mock 回复为中文,可用于验证 CJK 渲染。
8. 复现步骤(真机 + adb,3 条命令):
   `adb install -r app-debug.apk && adb shell am start -n com.example.deepseekchat/.MainActivity`
   `python3 /root/mock-api.py &`  # 宿主 0.0.0.0:8899
   设置页选 Anthropic-compatible → 填 http://<宿主IP>:8899 / mock-model / 任意 Key → Test → 关闭 → 发消息(观察是否弹回设置页)
