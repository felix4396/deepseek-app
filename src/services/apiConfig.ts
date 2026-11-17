import { create } from 'zustand'

/**
 * 服务配置：一组三个字段，全部存 localStorage。
 * - chat-demo:api-key  沿用原 key 名，旧数据天然兼容
 * - chat-demo:base-url 服务地址（origin，不含 /anthropic/v1 这类协议前缀）
 * - chat-demo:model    请求里的 model
 * 未配置时分别回落到构建期默认地址与 deepseek-flash。
 */
export type ApiConfig = {
  apiKey: string
  baseUrl: string
  model: string
}

/** 构建期注入的默认服务地址，仅在未配置时兜底 */
export const DEFAULT_BASE_URL: string = __API_ORIGIN__
export const DEFAULT_MODEL = 'deepseek-flash'
/** Messages / Files 的协议前缀固定为官方的 /anthropic/v1，保证三条请求路径与改造前一致 */
export const API_PATH = '/anthropic/v1'

export const CONFIG_KEYS = {
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

/** 已保存的原始值（空串表示没配置过，使用默认值） */
export const useApiConfig = create<ApiConfig>(() => ({
  apiKey: read(CONFIG_KEYS.apiKey) ?? '',
  baseUrl: read(CONFIG_KEYS.baseUrl) ?? '',
  model: read(CONFIG_KEYS.model) ?? '',
}))

const resolveBaseUrl = (raw: string) => normalizeBaseUrl(raw) ?? DEFAULT_BASE_URL
const resolveModel = (raw: string) => raw.trim() || DEFAULT_MODEL

/** 每次请求都重新读取，切换/修改后立即生效 */
export const getApiKey = (): string => read(CONFIG_KEYS.apiKey) ?? ''
export const getBaseUrl = (): string => resolveBaseUrl(read(CONFIG_KEYS.baseUrl) ?? '')
export const getModel = (): string => resolveModel(read(CONFIG_KEYS.model) ?? '')

/** Messages / Files 前缀：baseUrl + /anthropic/v1（与改造前一致） */
export const getMessagesBaseUrl = (): string => `${getBaseUrl()}${API_PATH}`
/** GET /models 固定在根路径（官方与多数中转都在根上提供） */
export const getModelsUrl = (): string => `${getBaseUrl()}/models`
/** ASR / TTS 保持 /v1/tools 前缀 */
export const getToolsBaseUrl = (): string => `${getBaseUrl()}/v1/tools`

/** 保存 API Key；空值等于清除（回到未配置状态） */
export const setApiKey = (apiKey: string) => {
  const value = apiKey.trim()
  write(CONFIG_KEYS.apiKey, value || null)
  useApiConfig.setState({ apiKey: value })
}

/** 保存服务地址；非法返回 false 且不写入。空值等于清除（回到构建期默认地址） */
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
