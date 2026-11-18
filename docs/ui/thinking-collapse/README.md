# 思考过程折叠 / 隐藏：界面截图（#46）

截图方式：Playwright Chromium（headless）打开本地 dev 构建（`rspack serve`，http://127.0.0.1:8091/），
在 IndexedDB 里注入一条带思考块的历史会话后拍摄。

**这些是浏览器视口截图，不是真机（手机 / 平板）截图。**
两个视口宽度：`390 × 844`、`360 × 780`（CSS 像素，deviceScaleFactor = 2，图片是 2 倍图）。

| 文件 | 内容 |
| --- | --- |
| `before-390-default.png` / `before-360-default.png` | 改动前（`origin/main` @ 68b8f3a）：思考正文整段铺在消息里 |
| `after-390-default.png` / `after-360-default.png` | 改动后默认档「折叠」：只剩一行标题「已思考（用时 12 秒）」，思考正文不进 DOM |
| `after-390-expanded.png` / `after-360-expanded.png` | 点标题展开：思考正文出现，标题箭头朝下；展开只在这一次点击里生效，不写回默认 |
| `after-390-hidden.png` / `after-360-hidden.png` | 设置改成「不显示」：没有标题、没有占位，正文照常显示 |
| `after-390-settings.png` / `after-360-settings.png` | 设置 → 通用设置里的三档控件（折叠 / 展开 / 不显示） |

注入的会话内容：一次「为什么天空是蓝色的」问答，思考块约 300 字、7 个段落，正文一段。
