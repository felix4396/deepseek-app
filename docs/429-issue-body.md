## 状态
复现中 / in-progress。已完成纯 mock 复现与最小修复，本地候选待复核；没有发布、没有真实上游请求。检查现有 #1–#9，无相同429错误映射Issue。

## 问题与基线
1.4.0-beta.7 `d593312`。上游HTTP429若明确表示API额度耗尽，客户端最终仍显示“请求过于频繁，请稍后再试”，误导用户等待/重试而不是更换Key。
独立worktree：`/root/worktrees/deepseek-429-mapping`，分支 `test/429-error-mapping`，未改主目录。

## 复现步骤（全内存mock）
1. 基于d593312，替换fetch为Response mock，不读取用户Key、不访问上游。
2. 向ours/OpenAI、deepseek、anthropic协议入口返回HTTP429；合成JSON error只含code=`insufficient_quota`、type=`insufficient_quota`、message=`API额度用完，请更换Key`。
3. 响应头mock：`Retry-After:30`、`X-Request-ID:fixture-request`，另加合成Set-Cookie验证不保留敏感头。
4. 调用真实streamMessage/request，按store持久化字段构造reply，再调用真实describeReply与errorMeta。
5. 基线7/7复现断言通过：message仍在，但code/type丢失、classifyApiError=rateLimited、UI覆盖为频繁、quota标记retryable。修复后9/9验收通过。

## 准确错误链路（行号按基线）
- `src/services/api/providers.ts:167-178`：ours=openai协议/Bearer/chat-completions。
- `src/services/api/client.ts:223-238 → request:92-108 → readErrorResponse:66-81`：非2xx先于openaiAdapter解析；丢code/type/headers，保留status429与message。不是把其它状态转换成429，而是**429语义误分类**。
- `src/services/api/errors.ts:27-28,36-43`：所有429统一rateLimited。
- `src/services/chat/store.ts:1189-1198,1227-1232`：诊断ui.condition=rateLimited；reply仅保存message/status。
- `src/services/chat/describe.ts:34-40` + `src/i18n/zh.ts:77`：再次按status覆盖原始额度错误文案。
- `src/services/diagnostics/collector.ts:149-161`：基线仅保留脱敏message/status，没有上游code/type。
- `diagnostics/shared.ts`的429属于反馈提交，不是聊天上游链路，本次未改。

## 最小候选修复
本地commit：`74a3bda`（未push、未发布）。
保留ApiError.upstream.code/type/允许列表headers（retry-after/x-request-id/request-id），不保存完整响应体或凭证；明确额度机器码→quotaExhausted，明确限流机器码→rateLimited；没有已知语义的429保留原始message，**不依赖429、Retry-After或含糊文本猜测**。store持久化upstream，UI显示“上游额度不足，请更换 Key 后重试”并给更换Key入口；quota不标为可重试；诊断记录脱敏截断语义字段。

## 验收
- [x] 四个provider HTTP429 quota：上游code/type/message及允许列表headers保留，Set-Cookie丢弃。
- [x] UI额度提示可读并提供更换Key入口，持久化后重载映射仍正确。
- [x] 真正rate_limit_exceeded仍显示请求过于频繁，保持retryable。
- [x] 无code/未知code的429显示上游原始message，不伪装成限流。
- [x] diagnostics保留语义证据，不贴真实Key或用户请求/响应正文。
- [ ] review与浏览器/Android候选验收（不发布）。

## 测试结果
- `node tests/run-layer.mjs unit --only 429-error-mapping`：9/9 PASS。
- `node tests/run-layer.mjs unit --only provider-ours`：3/3 PASS。
- `node tests/run-layer.mjs unit --only openai-adapter`：28断言PASS。
- `npm run type`、`npm run lint`、`git diff --check`：PASS。
初次Node22 strip-only因TS参数属性报错，测试load hook已切换内置transform，focused runner无需额外flag；初次lint两处curly已修复并重跑通过。

## 未测边界
未请求真实Key/上游；未压测、未绕限流。未验证真实ours的429 code/type契约、代理改写、计费语义、CORS暴露响应头、Android/WebView UI点按、完整浏览器集成。HTTP200 SSE是另一条stream路径，本次证明原message透传，但code/type仍未保留（不在本次HTTP429最小修复内）。
若review后仅缺真实上游脱敏语义契约，可标status:blocked；当前保持status:in-progress，mock交付已完成。
