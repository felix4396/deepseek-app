# HTTP429 上游额度错误误映射：复现与最小修复

基线：`d593312`（1.4.0-beta.7）；独立 worktree `/root/worktrees/deepseek-429-mapping`，不改主目录，不发布。

## 现状证据 / 精确链路

1. `providers.ts:167-178`：ours 使用 OpenAI 协议、Bearer、`/v1/chat/completions`。
2. `client.ts:223-238`：streamOpenAIMessage 调用公共 request；HTTP 非2xx在进入 openaiAdapter 之前处理。
3. 基线 `client.ts:66-81`：readErrorResponse 保留 error.message，但丢弃 code/type/响应头；HTTP status仍是429，没有二次转换成429。
4. 基线 `errors.ts:27-28,36-43`：只看状态，所有429→rateLimited；quota也被isRetryableApiError标为可重试（不是自动重试的证据）。
5. 基线 `store.ts:1189-1198`：诊断ui.condition=rateLimited，errorMeta保留message/status但没有上游code/type。`store.ts:1227-1232`保存错误message/status但没有上游语义字段。
6. 基线 `describe.ts:34-40`：再次按status分类，覆盖原始message为`replyRateLimited`；`zh.ts:77`显示“请求过于频繁，请稍后再试”。
7. HTTP200 SSE错误是另一条路径：openaiAdapter.ts:270-274 → OpenAIStreamError → ApiError(stream)，status缺省，原始message直接显示。不是本次HTTP429误映射。
8. diagnostics/shared.ts中429→rate_limited属于反馈提交transport，与聊天上游错误分类无关，本次保持原样。

## 纯 mock 复现

`fetch`完全替换为内存Response，无真实网络请求、用户Key、上游访问、压测或绕限流。

模拟HTTP429，JSON error含 `code=insufficient_quota, type=insufficient_quota, message=API额度用完，请更换Key`；响应头 `Retry-After:30`, `X-Request-ID:fixture-request`。
在改动生产代码前执行 `node --experimental-transform-types --test tests/unit/429-error-mapping.test.mjs`：7/7通过（断言基线错误行为）。
初次不带transform运行因Node22原生strip-only不支持TS参数属性失败；最终测试内load hook使用内置stripTypeScriptTypes(transform)，runner无需额外flag。

## 最小修复

- ApiError新增upstream.code/type/headers，不占用本地code命名空间，不保存完整响应体；仅允许retry-after/x-request-id/request-id，排除Set-Cookie等。
- HTTP429且明确insufficient_quota/quota_exhausted等机器码→quotaExhausted；明确rate_limit_exceeded/rate_limit_error等→rateLimited。
- HTTP429没有已知机器码（即使有Retry-After）→other，显示原始message；不靠HTTP429或含糊文本猜测限流/额度。
- store持久化upstream，describe与诊断共用语义分类；quota显示“上游额度不足，请更换 Key 后重试”，提供更换Key入口；真正限流保持原提示；quota不标记可重试。
- errorMeta记录脱敏且截断的code/type/允许列表头；不记录凭证或整段响应正文。

## focused验收

`node tests/run-layer.mjs unit --only 429-error-mapping`

覆盖四个provider的HTTP429 quota、ours真正限流、仅message的429原文透传、HTTP200 SSE不同路径；验证原始message、机器码与允许列表头保留，敏感头丢弃，UI文案与重载后的错误映射。默认验收模式；`EXPECT_429_BASELINE=1`是基线复现断言，修复后该模式应失败。

## 未测边界 / 状态

真实ours上游429的code/type、代理是否改写响应、实际余额与额度计费语义、CORS暴露响应头、Android/WebView UI点按、完整浏览器集成、生产部署均未测试。SSE的code/type仍未保留，只有message透传；本次目标仅HTTP429。

mock复现和最小修复已完成；Issue保持in-progress等待review/真实脱敏错误契约确认，不将真实上游行为宣称为已验证。若后续仅阻塞在真实上游语义确认，可转status:blocked；mock交付不受影响。
