# 变更记录

本文件记录 deepseek-app 的重要变更，版本倒序排列。

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
