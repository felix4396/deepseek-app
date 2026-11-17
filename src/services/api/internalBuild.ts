/**
 * 内测版（internal build）的固定服务配置——**全应用只有这一处写死地址与模型**。
 *
 * 内测包（1.4.0-beta.1）面向的是「只填 API Key 就能用」的场景：服务地址、模型、服务类型
 * 三项都在构建期钉死，不进用户可编辑的 localStorage，设置页也不渲染对应的输入行
 * （由 ProviderSpec.fixed 驱动，见 providers.ts）。
 *
 * 怎么改：直接改下面的常量。改完重新构建内测包即可，其它模块不需要动。
 *
 * 为什么固定成 anthropic 而不是 deepseek：该上游只有 `/v1/messages`，没有 `/anthropic`
 * 前缀，也没有 DeepSeek 私有字段（safety_check / latest_reminder / title / tools），
 * 所以用「Anthropic 协议」这个 spec 的内置预设（paths.messages='/v1/messages'，
 * 鉴权 x-api-key，不带 anthropic-version 头避免中转 CORS 预检失败）。
 */
import type { ProviderKind } from './providers.js'

/** 内测版固定的服务地址（origin，不含 /v1 这类协议前缀） */
export const INTERNAL_BASE_URL = 'http://123.207.199.196:60010'

/** 内测版固定的模型 */
export const INTERNAL_MODEL = 'deepseek-v4.1-flash'

/** 内测版固定的服务类型：anthropic 兼容预设 */
export const INTERNAL_KIND: ProviderKind = 'anthropic'

/** 固定配置的形状：给了它就说明这一项用户改不了 */
export type FixedService = {
  kind: ProviderKind
  baseUrl: string
  model: string
}

/**
 * 是否内测构建：由 rspack 的 DefinePlugin 注入（`INTERNAL_BUILD=1 pnpm build:internal`）。
 * 非打包环境（node 单测直接 import 源码、dev server 默认构建）取不到该常量，
 * 用 try/catch 兜底成 false，避免 ReferenceError。
 */
export const INTERNAL_BUILD: boolean =
  typeof __INTERNAL_BUILD__ === 'undefined' ? false : __INTERNAL_BUILD__

/**
 * 内测版要钉死的三项；正式构建为 null（此时一切照旧，用户仍可自选服务类型并自填地址与模型）。
 */
export const FIXED_SERVICE: FixedService | null = INTERNAL_BUILD
  ? { kind: INTERNAL_KIND, baseUrl: INTERNAL_BASE_URL, model: INTERNAL_MODEL }
  : null
