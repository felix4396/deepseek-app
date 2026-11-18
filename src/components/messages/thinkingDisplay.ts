import type { ThinkingDisplay } from '../../services/settings.js'

/**
 * 思考过程（reasoning / think 内容）的区域布局判定。
 *
 * 抽成纯函数是为了两件事：
 * 1. 折叠时**不把正文挂到 DOM**（而不是渲染出来再用 CSS 隐藏）——长历史里有几十条思考，
 *    挂 DOM 的做法在低端 WebView 上会一直付 markdown 解析与布局的代价；
 * 2. 三档（collapsed / expanded / hidden）与流式状态组合多，能脱开 React 断言。
 */
export type ThinkingLayout = {
  /** 标题行（「正在思考」/「已思考（用时 N 秒）」）是否渲染 */
  showTitle: boolean
  /** 步骤正文（含思考正文）是否挂到 DOM */
  showSteps: boolean
  /** hidden 档：把 thinking 步骤整条从时间线里剔除（工具行与过程文字保留） */
  dropThinkingSteps: boolean
}

/**
 * 老数据兼容：会话里存下来的助手消息不一定带 `thinking` 标记（早期版本没记请求开关），
 * 所以按标记或步骤里是否真出现过 thinking 块来判断。
 */
export const hasThinkingContent = (
  thinkingFlag: boolean | undefined,
  steps: readonly { type: string }[]
): boolean => thinkingFlag === true || steps.some((step) => step.type === 'thinking')

/**
 * @param open 用户是否手动点开了标题；null 表示还没点过，按档位默认（expanded 档默认展开，
 *   其余默认收起）。纯界面状态，不写回设置。
 * @param hasResponse 本轮正文是否已经开始输出
 */
export const resolveThinkingLayout = ({
  mode,
  hasThinking,
  streaming,
  hasResponse,
  open,
}: {
  mode: ThinkingDisplay
  hasThinking: boolean
  streaming: boolean
  hasResponse: boolean
  open: boolean | null
}): ThinkingLayout => {
  if (mode === 'hidden') {
    return { showTitle: false, showSteps: false, dropThinkingSteps: true }
  }
  if (!hasThinking) {
    // 没有思考内容（例如普通搜索）时不显示思考标题，过程行照旧展示。
    return { showTitle: false, showSteps: true, dropThinkingSteps: false }
  }
  // 思考还在流式输出、正文尚未开始时自动展开，否则用户只看到一行标题、不知道在动。
  const thinkingActive = streaming && !hasResponse
  return {
    showTitle: true,
    showSteps: thinkingActive || (open ?? mode === 'expanded'),
    dropThinkingSteps: false,
  }
}

/** hidden 档下真正要渲染的步骤：剔除思考块，其他（搜索 / 浏览 / 过程文字）保留 */
export const selectVisibleSteps = <T extends { type: string }>(
  steps: readonly T[],
  layout: { dropThinkingSteps: boolean }
): readonly T[] =>
  layout.dropThinkingSteps ? steps.filter((step) => step.type !== 'thinking') : steps
