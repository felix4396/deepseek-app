import { useTranslate } from '../../i18n/index.js'
import { useApiConfig } from '../../services/api/apiConfig.js'
import { getSpec } from '../../services/api/providers.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'

/** 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止；正文原样提交，由服务端过滤 markdown */
export const ReadAloudButton = ({ messageId, text }: { messageId: string; text: string }) => {
  const t = useTranslate()
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  // 当前服务类型不支持朗读（caps.tts=false）时整个入口不渲染
  const caps = getSpec(useApiConfig((state) => state.kind)).caps
  if (!caps.tts) {
    return null
  }
  return (
    <IconButton
      icon={status === 'idle' ? <IconPlayMediaOutline16 /> : <ReadingBars mode={status} />}
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() =>
        toggleReadAloud(messageId, text, (error) => showToast(describeReadAloudError(error)))
      }
    />
  )
}
