/**
 * 内测构建（internal build）标记——这里只留「是不是内测包」这一个事实。
 *
 * 1.4.0-beta.3 起，内测包不再把地址 / 模型 / 渠道写死在这里：
 * 它们变成 providers.ts 里的第四个渠道 `ours`（内置地址与模型写在该 spec 的 defaults 里），
 * 内测包只是把**默认渠道**换成 `ours`（见 providers.ts 的 DEFAULT_PROVIDER_KIND）。
 * 用户仍然可以在设置页切到 DeepSeek 官方 / Anthropic 协议 / OpenAI 兼容。
 */

/**
 * 是否内测构建：由 rspack 的 DefinePlugin 注入（`INTERNAL_BUILD=1 pnpm build:internal`）。
 * 非打包环境（node 单测直接 import 源码、dev server 默认构建）取不到该常量，
 * 用 try/catch 兜底成 false，避免 ReferenceError。
 */
export const INTERNAL_BUILD: boolean =
  typeof __INTERNAL_BUILD__ === 'undefined' ? false : __INTERNAL_BUILD__
