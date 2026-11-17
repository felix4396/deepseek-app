import { create } from 'zustand'
import {
  DEFAULT_PROVIDER_KIND,
  getSpec,
  isProviderKind,
  type ProviderCaps,
  type ProviderKind,
  type ProviderSpec,
} from './providers.js'

/**
 * 服务配置：服务类型 + 三个字段，全部存 localStorage。
 * - chat-demo:provider-kind  服务类型（deepseek / anthropic）；旧用户没有这个 key，按 deepseek 处理
 * - chat-demo:api-key        沿用原 key 名，旧数据天然兼容
 * - chat-demo:base-url       服务地址（origin，不含 /v1 这类协议前缀）
 * - chat-demo:model          请求里的 model
 *
 * 请求路径与鉴权头都来自 ProviderSpec（providers.ts），这里只负责「当前用哪个 spec + 取到值」。
 */
export type ApiConfig = {
  kind: ProviderKind
  apiKey: string
  baseUrl: string
  model: string
}

/** 构建期注入的默认服务地址，仅在服务类型与已存值都取不到时兜底 */
export const DEFAULT_BASE_URL: string = __API_ORIGIN__
export const DEFAULT_MODEL = 'deepseek-flash'

export const CONFIG_KEYS = {
  kind: 'chat-demo:provider-kind',
  apiKey: 'chat-demo:api-key',
  baseUrl: 'chat-demo:base-url',
  model: 'chat-demo:model',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/**
 * 服务地址校验：必须是 http(s) 且能被 new URL() 解析，保存时去掉尾斜杠。
 * 返回 null 表示非法。
 */
export const normalizeBaseUrl = (value: string): string | null => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }
    if (!url.hostname) {
      return null
    }
    return trimmed
  } catch {
    return null
  }
}

/** 当前生效的服务类型；旧数据（没有 kind）回落到 deepseek */
export const getProviderKind = (): ProviderKind => {
  const saved = read(CONFIG_KEYS.kind)
  return isProviderKind(saved) ? saved : DEFAULT_PROVIDER_KIND
}

/** 已保存的原始值（空串表示没配置过，使用默认值） */
export const useApiConfig = create<ApiConfig>(() => ({
  kind: getProviderKind(),
  apiKey: read(CONFIG_KEYS.apiKey) ?? '',
  baseUrl: read(CONFIG_KEYS.baseUrl) ?? '',
  model: read(CONFIG_KEYS.model) ?? '',
}))

/** 当前生效的 spec：路径、鉴权头、能力开关都从它取 */
export const getCurrentSpec = (): ProviderSpec => getSpec(getProviderKind())

/** 某项能力在当前服务类型下是否可用 */
export const getCaps = (): ProviderCaps => getCurrentSpec().caps

/**
 * 服务地址：已存的值优先（升级前配过中转的用户保持原样），
 * 其次用当前 spec 的内置默认，最后回落到构建期地址。
 */
const resolveBaseUrl = (): string => {
  const stored = normalizeBaseUrl(read(CONFIG_KEYS.baseUrl) ?? '')
  if (stored) {
    return stored
  }
  return getCurrentSpec().defaults?.baseUrl ?? DEFAULT_BASE_URL
}

/** 模型：同上，已存值优先，其次 spec 默认，最后 deepseek-flash */
const resolveModel = (): string => {
  const stored = (read(CONFIG_KEYS.model) ?? '').trim()
  if (stored) {
    return stored
  }
  return getCurrentSpec().defaults?.model ?? DEFAULT_MODEL
}

/** 每次请求都重新读取，切换/修改后立即生效 */
export const getApiKey = (): string => read(CONFIG_KEYS.apiKey) ?? ''
export const getBaseUrl = (): string => resolveBaseUrl()
export const getModel = (): string => resolveModel()

/** GET 模型列表：baseUrl + paths.models（官方 /models，Anthropic 兼容 /v1/models） */
export const getModelsUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.models}`
/** 发消息：baseUrl + paths.messages */
export const getMessagesUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.messages}`
/** Messages 前缀，附件接口挂在其下（`{messages}/files`） */
export const getMessagesBaseUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.messages}`
/** ASR / TTS 等工具接口前缀 */
export const getToolsBaseUrl = (): string => `${getBaseUrl()}${getCurrentSpec().paths.tools}`

/** 保存服务类型并立即生效（路径、鉴权头、按钮显隐随之切换） */
export const setProviderKind = (kind: ProviderKind) => {
  write(CONFIG_KEYS.kind, isProviderKind(kind) ? kind : DEFAULT_PROVIDER_KIND)
  useApiConfig.setState({ kind })
}

/** 保存 API Key；空值等于清除（回到未配置状态） */
export const setApiKey = (apiKey: string) => {
  const value = apiKey.trim()
  write(CONFIG_KEYS.apiKey, value || null)
  useApiConfig.setState({ apiKey: value })
}

/** 保存服务地址；非法返回 false 且不写入。空值等于清除（回到内置默认地址） */
export const setBaseUrl = (baseUrl: string): boolean => {
  if (!baseUrl.trim()) {
    write(CONFIG_KEYS.baseUrl, null)
    useApiConfig.setState({ baseUrl: '' })
    return true
  }
  const value = normalizeBaseUrl(baseUrl)
  if (!value) {
    return false
  }
  write(CONFIG_KEYS.baseUrl, value)
  useApiConfig.setState({ baseUrl: value })
  return true
}

/** 保存模型；空值非法（返回 false），清除请传 null */
export const setModel = (model: string, reset = false): boolean => {
  if (reset) {
    write(CONFIG_KEYS.model, null)
    useApiConfig.setState({ model: '' })
    return true
  }
  const value = model.trim()
  if (!value) {
    return false
  }
  write(CONFIG_KEYS.model, value)
  useApiConfig.setState({ model: value })
  return true
}
