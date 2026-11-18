# Issue #25 修复前失败证据（红）

命令（公开构建 dev 服务器 + Playwright 路由拦截的 mock 上游，不改源码）：

    pnpm dev                                                   # 127.0.0.1:8090
    APP_URL=http://127.0.0.1:8090 node tests/integration/mode-switch-request.test.mjs

输出（修复前，commit 68b8f3a）：

    # 快速模式
      ok  首次进入默认是快速模式
      ok  快速模式下抓到了请求体（351 字节）
    # 专家模式（刷新后重新选择）
      ok  刷新后回到快速模式（说明模式不持久化）
      ok  专家模式下抓到了请求体（351 字节）
    # 两次请求体逐字节对比
      ✗   两种模式的请求体完全相同（逐字节一致，没有任何字段随模式变化）
    # 模式持久化（刷新后是否保留）
      ✗   刷新后仍是刷新前选的模式（实际：fast）
      ✗   再次刷新仍保留专家模式
      ok  刷新后的专家模式请求体与刷新前一致（没有退回快速模式）
    3 项不通过

两次抓到的请求体（`docs/ui/mode-switch/request-bodies.json` 里 rawEqual=true）：
快速与专家都是同一份 351 字节，`"thinking":{"type":"disabled"}`，`model` 都是 `deepseek-flash`。

# 修复后（绿）

    # 两次请求体逐字节对比
      ok  两种模式的请求体不同，共 1 处字段差异
          · thinking: fast={"type":"disabled"} → expert={"type":"enabled"}
    # 模式持久化（刷新后是否保留）
      ok  刷新后仍是刷新前选的模式（expert）
      ok  再次刷新仍保留专家模式
    全部通过

截图：`welcome-expert-390.png`（390×844）/`welcome-expert-360.png`（360×800），
Chromium 视口截图，非真机。
