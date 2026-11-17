import { getRegionName, provinces, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

const locationName = (location: UserLocation | null, locale: Locale): string => {
  if (!location) {
    return ''
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

/**
 * 模型约定的五项信息（日期 / 星期 / 所在地 / 平台 / 语言）；日期与星期使用浏览器本地时区，
 * 避免 UTC 日期跨日。
 *
 * 1.4.0-beta.1 起设置页不再暴露「位置信息」，location 通常为 null：此时所在地这一段直接省略，
 * 不会留下空段（避免 `日期,星期,,Web,语言` 这种空洞，更不会出现 undefined）。
 */
export const createLatestReminder = (
  { locale, location }: { locale: Locale; location: UserLocation | null },
  now = new Date()
): string => {
  const parts = [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale),
    'Web',
    translate('latestReminderLanguage'),
  ]
  return parts
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(',')
}
