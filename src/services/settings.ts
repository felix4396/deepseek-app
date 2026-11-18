import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/**
 * 快速 / 专家模式。**不是纯样式**：它是「本轮请求的思考档位」的唯一入口，
 * 由 services/chat/store.ts 的 createReply 读进 AssistantMessage.thinking，
 * 最终落到请求体的 thinking.type（disabled / enabled）—— 见 issue #25。
 */
export type ChatMode = 'fast' | 'expert'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 本机设置，存 localStorage：语言、主题、位置、朗读音色、快速/专家模式（= 深度思考档位）、智能搜索开关、侧边栏收起状态。
 * API Key 不再单独存放，改由 providers.ts 的模型服务配置管理（旧 chat-demo:api-key 仅用于迁移）。
 */
type Settings = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  chatMode: ChatMode
  /** 深度思考开关的镜像值，恒等于 chatMode === 'expert'；留着是为了不改读它的旧代码 */
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  chatMode: 'chat-demo:chat-mode',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
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

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 未保存过模式时按旧的「深度思考」键迁移：开着的用户继续算专家模式 */
const initialChatMode = (): ChatMode => {
  const saved = read(KEYS.chatMode)
  if (saved === 'fast' || saved === 'expert') {
    return saved
  }
  return read(KEYS.thinking) === 'true' ? 'expert' : 'fast'
}

export const useSettings = create<Settings>(() => {
  const chatMode = initialChatMode()
  return {
    locale: initialLocale(),
    location: initialLocation(),
    themePreference: initialThemePreference(),
    ttsVoice: initialTtsVoice(),
    chatMode,
    thinking: chatMode === 'expert',
    search: read(KEYS.search) === 'true',
    siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  }
})

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

/**
 * 切换快速 / 专家模式（唯一写入口）。新模式落 localStorage，刷新、切会话都不丢；
 * 旧键 chat-demo:thinking 一起同步，读 thinking 的旧代码（输入行开关、回复快照）行为不变。
 */
export const setChatMode = (chatMode: ChatMode) => {
  const thinking = chatMode === 'expert'
  write(KEYS.chatMode, chatMode)
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ chatMode, thinking })
}

/** 输入行的「深度思考」开关与模式是同一件事，点它等于切模式 */
export const setThinking = (thinking: boolean) => setChatMode(thinking ? 'expert' : 'fast')

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
