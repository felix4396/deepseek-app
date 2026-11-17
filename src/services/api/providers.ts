/**
 * 服务类型（ProviderSpec）注册表：一个服务类型 = 一个 spec 对象。
 *
 * 设置页的输入行、请求路径、鉴权头、能力开关（搜索/附件/语音/朗读/标题）
 * 以及请求体里能带哪些 DeepSeek 扩展字段，全部由这里驱动。
 *
 * 新增一个服务类型只需要：把它加进 ProviderKind，并在 SPECS 里补一个对象；
 * 设置页与请求构造不用改任何结构（组件按 spec.fields 循环渲染、按 spec.caps 控制显隐）。
 * 协议不同（OpenAI 兼容）的额外工作是 openaiAdapter.ts 里的双向翻译，同样与组件无关。
 */

export type ProviderKind = 'deepseek' | 'anthropic' | 'openai'

/**
 * 线上协议：决定请求体怎么构造、响应流怎么解析。
 * - 'anthropic'：Messages API（本应用内部就是这套事件，直接透传）
 * - 'openai'：chat/completions，经 openaiAdapter.ts 双向翻译
 */
export type ProviderProtocol = 'anthropic' | 'openai'

/** 需要用户填的字段；不在列表里的字段用 defaults 里的内置默认值 */
export type ProviderField = 'baseUrl' | 'apiKey' | 'model'

/** 鉴权头：'x-api-key' 走 Anthropic 风格（另带 anthropic-version），'bearer' 走 OpenAI 风格 */
export type ProviderAuth = 'x-api-key' | 'bearer'

/** 能力开关：决定界面上哪些入口可用，以及请求体里能带哪些扩展字段 */
export type ProviderCaps = {
  /** 基础文本对话（流式正文、停止、重新生成 / 编辑 / 分支） */
  text: boolean
  /** 深度思考开关（thinking / reasoning） */
  thinking: boolean
  /** 智能搜索（deepseek_web_search） */
  search: boolean
  /** 服务端自动生成会话标题 */
  title: boolean
  /** 图片等附件（Files API + image/document block） */
  vision: boolean
  /** 朗读（TTS） */
  tts: boolean
  /** 语音输入（ASR） */
  asr: boolean
}

export type ProviderPaths = {
  /** 模型列表 */
  models: string
  /** 发消息（files 上传也挂在这个前缀下：`{messages}/files`） */
  messages: string
  /** 语音等工具接口前缀 */
  tools: string
}

export type ProviderSpec = {
  kind: ProviderKind
  label: { zh: string; en: string }
  /** 线上协议：请求体与响应流按它选解析方式 */
  protocol: ProviderProtocol
  /** 需要用户填哪些字段，顺序即设置页里的渲染顺序 */
  fields: ProviderField[]
  /** 未显示的字段用内置默认；用户已存过的值仍然优先（升级无感兼容） */
  defaults?: { baseUrl?: string; model?: string }
  paths: ProviderPaths
  auth: ProviderAuth
  /**
   * x-api-key 鉴权时附带 anthropic-version 头的值。留空表示不发这个头。
   * 只在「打官方端点（defaults.baseUrl 的 host）」时才带：第三方中转的 CORS 白名单
   * 常常只放行 x-api-key，多带这个头会让浏览器预检直接失败（60010 实测），
   * 而官方端点不需要也无法避免（它是协议要求）。
   */
  anthropicVersion?: string
  caps: ProviderCaps
  /**
   * DeepSeek 扩展字段：safety_check 与 role:'latest_reminder'。
   * 裸 Anthropic 协议不认识它们（未知顶层字段 / 非法 role 都会 400），所以只能按 spec 发。
   */
  extended?: { safetyCheck: boolean; latestReminder: boolean }
  /** 开启 thinking 时需要附带的最小思考预算；不填表示该协议不需要这个字段 */
  thinkingBudget?: number
}

/** Anthropic 风格接口要求的协议版本头 */
export const ANTHROPIC_VERSION = '2023-06-01'

const SPECS: Record<ProviderKind, ProviderSpec> = {
  deepseek: {
    kind: 'deepseek',
    label: { zh: 'DeepSeek 官方', en: 'DeepSeek Official' },
    protocol: 'anthropic',
    // 官方地址与模型都写死，用户只需要填 Key
    fields: ['apiKey'],
    defaults: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    paths: { models: '/models', messages: '/anthropic/v1/messages', tools: '/v1/tools' },
    auth: 'x-api-key',
    // 官方 CORS 白名单包含 anthropic-version（实测 OPTIONS 允许 x-api-key,anthropic-version）
    anthropicVersion: ANTHROPIC_VERSION,
    caps: {
      text: true,
      thinking: true,
      search: true,
      title: true,
      vision: true,
      tts: true,
      asr: true,
    },
    extended: { safetyCheck: true, latestReminder: true },
  },
  anthropic: {
    kind: 'anthropic',
    label: { zh: 'Anthropic 协议', en: 'Anthropic-compatible' },
    protocol: 'anthropic',
    // 任意 Anthropic 兼容中转：地址与模型都要自己填
    fields: ['baseUrl', 'apiKey', 'model'],
    paths: { models: '/v1/models', messages: '/v1/messages', tools: '/v1/tools' },
    auth: 'x-api-key',
    // 故意不带 anthropic-version：中转的 CORS 白名单一般只放行 x-api-key，
    // 带上后预检失败会让每个请求都变成网络错误（60010 实测）。
    caps: {
      text: true,
      thinking: true,
      search: false,
      title: false,
      vision: false,
      tts: false,
      asr: false,
    },
    // 深度思考仍然可用，但真 Anthropic 要求带 budget_tokens
    thinkingBudget: 4096,
  },
  openai: {
    kind: 'openai',
    label: { zh: 'OpenAI 兼容', en: 'OpenAI-compatible' },
    protocol: 'openai',
    // 任意 OpenAI 兼容上游（官方 / 中转 / 本地 vLLM、Ollama…）：地址与模型都要自己填
    fields: ['baseUrl', 'apiKey', 'model'],
    paths: { models: '/v1/models', messages: '/v1/chat/completions', tools: '' },
    // Authorization: Bearer <key>
    auth: 'bearer',
    // 只做基础对话：搜索/标题/附件/语音/朗读全关，深度思考也没给开关
    // （请求侧的 thinking 字段直接丢弃，理由见 openaiAdapter.ts 文件头）
    caps: {
      text: true,
      thinking: false,
      search: false,
      title: false,
      vision: false,
      tts: false,
      asr: false,
    },
  },
}

export const DEFAULT_PROVIDER_KIND: ProviderKind = 'deepseek'

export const PROVIDER_KINDS = Object.keys(SPECS) as ProviderKind[]

/** 下拉里的选项（顺序即展示顺序） */
export const PROVIDER_SPECS: ProviderSpec[] = PROVIDER_KINDS.map((kind) => SPECS[kind])

export const isProviderKind = (value: unknown): value is ProviderKind =>
  typeof value === 'string' && Object.hasOwn(SPECS, value)

/** 取 spec：未知/缺省（旧用户没有这个 key）一律按 deepseek 处理 */
export const getSpec = (kind?: string | null): ProviderSpec =>
  isProviderKind(kind) ? SPECS[kind] : SPECS[DEFAULT_PROVIDER_KIND]

/**
 * 请求体字段的「发 / 不发」：集中成一张表，构造请求时只查表，不写 if-else 分支。
 * - safety_check / latest_reminder 是 DeepSeek 扩展（裸 Anthropic 会 400）
 * - tools / title 对应 caps.search / caps.title
 * - thinking_budget 表示开启 thinking 时要附 budget_tokens
 */
export type RequestGate = 'safety_check' | 'latest_reminder' | 'tools' | 'title' | 'thinking_budget'

export const REQUEST_GATES: RequestGate[] = [
  'safety_check',
  'latest_reminder',
  'tools',
  'title',
  'thinking_budget',
]

/** 某个 spec 下各字段是否发送 */
export const requestGates = (spec: ProviderSpec): Record<RequestGate, boolean> => ({
  safety_check: spec.extended?.safetyCheck ?? false,
  latest_reminder: spec.extended?.latestReminder ?? false,
  tools: spec.caps.search,
  title: spec.caps.title,
  thinking_budget: Boolean(spec.thinkingBudget),
})
