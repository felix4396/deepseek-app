# 变更记录

本文件记录 deepseek-app 的重要变更，版本倒序排列。

## 1.2.3 (2026-11-17)

- 设置页新增「服务类型」下拉（versionCode 6）：
  - **DeepSeek 官方**（默认）：只需填 API Key，服务地址与模型使用内置默认值；`/models`、`/anthropic/v1/messages`、`/v1/tools` 三条路径与改造前逐字一致，`safety_check`/`title`/`tools`/`latest_reminder`/`thinking` 原样发送
  - **Anthropic 协议**：可自填服务地址与模型，路径改为 `/v1/models`、`/v1/messages`，鉴权同为 `x-api-key`
- Anthropic 兼容模式**只保留基础对话**：流式文本、停止、重新生成/编辑/分支与可选「深度思考」（自动补 `budget_tokens: 4096`）可用；智能搜索、阅读链接、自动标题、附件/图片、语音输入、朗读等入口在界面上隐藏或置灰，不会出现「发了请求却静默丢弃」的半吊子适配
- Anthropic 兼容模式请求体自动剥离 DeepSeek 私有字段：不发 `safety_check`、`title`、`tools` 与 `role:'latest_reminder'`；`latest_reminder` 的内容折进 `system` 前缀，信息不丢
- 上游返回网页（`text/html`，通常是路径填错或网关异常）时给出明确中文错误，不再把 HTML 当回答显示
- 新增本地 mock 端到端验收 `tests/run-acceptance.mjs` 及 8 个专项回归用例（路径/请求体/能力降级/HTML 上游/旧配置兼容等），不依赖真实上游
- 测试脚本默认使用 `http://127.0.0.1:5181`（安全上下文），语音输入用例不再因非 HTTPS 页面被置灰而失败

## 1.2.2 (2026-11-17)

- 修复设置页「测试」按钮误报 `Invalid api key`：探测请求改用 API Key 输入框的当前值，而不是 store 里已保存（可能为空）的旧值，不必先点「确定」再测试（versionCode 5）
- 未填写 API Key 时点「测试」会直接提示「请先填写 API Key」，不再发出空 `Authorization: Bearer` 请求
- 新增 Playwright 回归测试 `tests/test.probe-auth.spec.mjs`、`tests/test.probe-nokey.spec.mjs`

## 1.2.1 (2026-11-17)

- 允许 Android WebView 混合内容，修复 http 上游地址无法连通的问题（versionCode 4）

## 1.2.0 (2026-11-17)

- 新增聊天背景图功能：支持选择本地图片作为聊天背景，图片压缩至 1600px 上限后存入 IndexedDB，提供亮/暗主题遮罩保证可读性（versionCode 3）
- 数据库版本 11 → 12 迁移，新增 appAssets 表，迁移过程不丢数据
- 设置页新增「聊天背景」配置项，支持应用/更换/清除背景

## 1.1.0 (2026-11-17)

- 新增服务地址（Service URL）与模型可配置，API Key 本地存储（versionCode 2）
- 新增 API Key 连通性测试，配置错误提示更清晰
- 历史记录导入错误提示优化

## 1.0.0 (2026-11-17)

- 首个版本：Capacitor 套壳 Android 应用（versionCode 1）
- 支持自定义服务地址访问 DeepSeek 兼容接口
