import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { COPY_LIMIT_BYTES, copyText, exceedsCopyLimit, kibibytes } from '../../utils/clipboard.js'
import { savePlainText } from '../../utils/savePlainText.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconCopyOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'

/** 超过剪贴板上限时改存的文件名 */
const SAVE_FILENAME = 'deepseek-reply.txt'

/**
 * 复制成功后图标换成对勾 1 秒，期间再次点击不重复复制。
 * 文本超过 COPY_LIMIT_BYTES 时不写剪贴板（WebView 会静默截断或返回伪成功），
 * 改为弹出「保存为 TXT」的出口，且不进入 copied 状态。
 */
export const CopyButton = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const [tooLarge, setTooLarge] = useState(false)
  const [saving, setSaving] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timerRef.current), [])

  const save = async () => {
    if (saving) {
      return
    }
    setSaving(true)
    try {
      // 取消保存不算失败：静默关闭即可。
      await savePlainText(SAVE_FILENAME, text)
      setTooLarge(false)
    } catch {
      showToast({ key: 'copySaveFailed', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <IconButton
        icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        tooltip={t('copy')}
        tooltipPlacement="bottom"
        onClick={async () => {
          if (copied) {
            return
          }
          if (exceedsCopyLimit(text)) {
            setTooLarge(true)
            return
          }
          if (!(await copyText(text))) {
            showToast({ key: 'copyFailed' })
            return
          }
          setCopied(true)
          timerRef.current = setTimeout(() => setCopied(false), 1000)
        }}
      />
      {tooLarge ? (
        <Modal
          title={t('copyTooLargeTitle')}
          closable
          onClose={() => setTooLarge(false)}
          footer={
            <>
              <Button variant="outlined" size="m" onClick={() => setTooLarge(false)}>
                {t('cancel')}
              </Button>
              <Button size="m" disabled={saving} onClick={save}>
                {t('copyTooLargeSave')}
              </Button>
            </>
          }
        >
          <p>{t('copyTooLargeBody', { size: kibibytes(text), limit: COPY_LIMIT_BYTES / 1024 })}</p>
        </Modal>
      ) : null}
    </>
  )
}
