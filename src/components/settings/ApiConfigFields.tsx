import { useEffect, useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeBaseUrl,
  setBaseUrl,
  setModel,
  useApiConfig,
} from '../../services/apiConfig.js'
import { probeProvider, type ProviderProbeResult } from '../../services/api/client.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconButton } from '../base/IconButton.js'
import { useApiKeyForm } from './useApiKeyForm.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import styles from './Settings.module.css'

/** API Key 的编辑状态：输入框与移动端底部的「确定」按钮共用 */
export const useApiKeyEditor = () => {
  const apiKey = useApiConfig((state) => state.apiKey)
  const [editing, setEditing] = useState(false)
  const form = useApiKeyForm(() => setEditing(false))
  return { apiKey, editing, setEditing, form, showInput: !apiKey || editing }
}

type ApiKeyEditor = ReturnType<typeof useApiKeyEditor>

/** 服务配置三件套：API Key、服务地址、模型。与原有 API Key 区同样的卡片、行高与圆角 */
export const ApiConfigFields = ({ editor }: { editor: ApiKeyEditor }) => (
  <>
    <ApiKeyField editor={editor} />
    <BaseUrlField editor={editor} />
    <ModelField />
  </>
)

/** API Key：保存后只显示掩码，点编辑按钮才能重新输入 */
const ApiKeyField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const { apiKey, editing, setEditing, form, showInput } = editor

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('apiKeyStart')}</div>
        {apiKey && !editing ? (
          <div className={styles.apiKeySaved}>
            <span className={styles.apiKeyMask}>{'*'.repeat(apiKey.length)}</span>
            <IconButton
              tone="primary"
              icon={<IconEditOutline16 />}
              tooltip={t('apiKeyEdit')}
              onClick={() => setEditing(true)}
            />
          </div>
        ) : (
          <div className={styles.apiKeyInput}>
            <input
              type="password"
              placeholder={t('apiKeyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              // 移动端打开设置时不弹键盘，点编辑后才聚焦
              autoFocus={!isMobile || editing}
              value={form.value}
              onChange={(event) => form.setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  void form.submit()
                }
              }}
              onBlur={() => {
                // 修改时没输入就离开，回到已保存的状态
                if (apiKey && !form.value.trim()) {
                  setEditing(false)
                }
              }}
            />
            {!isMobile && form.value.trim() ? (
              <>
                <span className={styles.divider} />
                <button
                  type="button"
                  className={styles.confirm}
                  disabled={form.verifying}
                  // 保持输入框焦点
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void form.submit()}
                >
                  {form.verifying ? t('apiKeyVerifying') : t('confirm')}
                </button>
              </>
            ) : null}
          </div>
        )}
        {showInput && form.error ? <div className={styles.error}>{form.error}</div> : null}
      </div>
    </div>
  )
}

/** 服务地址：失焦或回车保存，尾部「测试」按钮会先保存再请求 {baseUrl}/models */
const BaseUrlField = ({ editor }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  const stored = useApiConfig((state) => state.baseUrl)
  const [value, setValue] = useState(stored || DEFAULT_BASE_URL)
  const [error, setError] = useState<TranslationKey | null>(null)
  const [keyError, setKeyError] = useState<TranslationKey | null>(null)
  const [testing, setTesting] = useState(false)
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null)

  // 外部（其他标签页打开时的初始值 / 保存后的规范化结果）变化时同步
  useEffect(() => {
    setValue(stored || DEFAULT_BASE_URL)
  }, [stored])

  const save = (): boolean => {
    // 清空即回到构建期默认地址（与「未填则用默认值」一致）
    if (!value.trim()) {
      setError(null)
      setProbe(null)
      setBaseUrl('')
      setValue(DEFAULT_BASE_URL)
      return true
    }
    const normalized = normalizeBaseUrl(value)
    if (!normalized) {
      setError('settingsBaseUrlInvalid')
      return false
    }
    setError(null)
    if (normalized !== value) {
      setValue(normalized)
    }
    setBaseUrl(normalized)
    return true
  }

  /**
   * 测试要用的 API Key：以输入框当前的受控值为准（用户打完字还没点「确定」时 store 里还是空的），
   * 输入框没内容时回落到已保存的 Key。
   */
  const currentApiKey = (): string => editor.form.value.trim() || editor.apiKey

  const test = async () => {
    if (testing) {
      return
    }
    // 先落盘再测试，保证测的就是要用的地址
    if (!save()) {
      return
    }
    const apiKey = currentApiKey()
    if (!apiKey) {
      // 没有 Key 就发请求只会得到空鉴权的 401，直接在本地拦下
      setKeyError('settingsTestApiKeyRequired')
      setProbe(null)
      return
    }
    setKeyError(null)
    setTesting(true)
    setProbe(null)
    try {
      setProbe(await probeProvider({ baseUrl: value, apiKey }))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsBaseUrlLabel')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            inputMode="url"
            placeholder={DEFAULT_BASE_URL}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settingsBaseUrlLabel')}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
              setProbe(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                save()
              }
            }}
            onBlur={save}
          />
          <span className={styles.divider} />
          <button
            type="button"
            className={styles.confirm}
            disabled={testing}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void test()}
          >
            {testing ? t('settingsTesting') : t('settingsTest')}
          </button>
        </div>
        {keyError ? <div className={styles.error}>{t(keyError)}</div> : null}
        {error ? <div className={styles.error}>{t(error)}</div> : null}
        {probe ? <div className={styles.description}>{describeProbe(t, probe)}</div> : null}
      </div>
    </div>
  )
}

/** 模型：失焦或回车保存，不能为空 */
const ModelField = () => {
  const t = useTranslate()
  const stored = useApiConfig((state) => state.model)
  const [value, setValue] = useState(stored || DEFAULT_MODEL)
  const [error, setError] = useState<TranslationKey | null>(null)

  useEffect(() => {
    setValue(stored || DEFAULT_MODEL)
  }, [stored])

  const save = () => {
    if (!value.trim()) {
      setError('settingsModelInvalid')
      return
    }
    setError(null)
    if (!setModel(value)) {
      setError('settingsModelInvalid')
      return
    }
    setValue(value.trim())
  }

  return (
    <div className={styles.cell}>
      <div className={styles.apiKey}>
        <div className={styles.label}>{t('settingsModelLabel')}</div>
        <div className={styles.apiKeyInput}>
          <input
            type="text"
            placeholder={DEFAULT_MODEL}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('settingsModelLabel')}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                save()
              }
            }}
            onBlur={save}
          />
        </div>
        {error ? <div className={styles.error}>{t(error)}</div> : null}
      </div>
    </div>
  )
}

/** 把连通性测试结果翻成一句可读提示，不抛异常 */
const describeProbe = (
  t: ReturnType<typeof useTranslate>,
  probe: ProviderProbeResult
): string => {
  switch (probe.reason) {
    case 'invalid':
      return t('settingsBaseUrlInvalid')
    case 'timeout':
      return t('settingsTestTimeout')
    case 'network':
      return t('settingsTestNetwork', { message: probe.message ?? '' })
    case 'json':
      return t('settingsTestBadJson', { message: probe.message ?? '' })
    case 'http':
      return t('settingsTestHttp', {
        status: probe.status ?? 0,
        message: probe.message ?? '',
      })
    default:
      break
  }
  const status = probe.status ?? 0
  if (probe.models.length === 0) {
    return t('settingsTestOkEmpty', { status })
  }
  return t('settingsTestOk', {
    status,
    count: probe.models.length,
    models: probe.models.slice(0, 5).join(', '),
  })
}

/** 移动端：输入 API Key 时在选项下方显示整行「确定」 */
export const ApiKeyConfirm = ({ editor: { showInput, form } }: { editor: ApiKeyEditor }) => {
  const t = useTranslate()
  return showInput && form.value.trim() ? (
    <button
      type="button"
      className={styles.mobileConfirm}
      disabled={form.verifying}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void form.submit()}
    >
      {form.verifying ? t('apiKeyVerifying') : t('confirm')}
    </button>
  ) : null
}
