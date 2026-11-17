# 端到端回归测试（Playwright）

覆盖设置页「服务地址」那一行「测试」按钮的鉴权行为：

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
