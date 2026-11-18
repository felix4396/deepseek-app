/**
 * 设备码（device_id）：生成、校验、持久化。
 *
 * 为什么单独一个文件：
 *  - 生成与校验是纯函数（可注入随机源、可注入存储），Node 单测零浏览器就能跑；
 *  - 存储只有这一份实现，避免「某个入口读到了另一个 key」导致同一个用户算出两个账号。
 *
 * 硬性约定（产品要求 1）：
 *  - 长度 8–128，字符集 `[A-Za-z0-9._:-]`
 *  - 首次启动生成后持久化，**不因切渠道 / 改 Key / 清对话而丢失**（只在清站点数据时丢）
 *  - 「设备码丢失等于丢账号」：设置里完整可见、可复制、可备份
 *  - device_id 是账号凭据的一部分：**不进日志、不进诊断、不进错误文案**（要用只用尾 4 位）
 */

/** localStorage 的 key：和其它配置同前缀，但**不属于**渠道配置，切渠道不会动它 */
export const DEVICE_ID_STORAGE_KEY = 'chat-demo:ours-device-id'

/** 服务端约束：8–128 位，字符集 [A-Za-z0-9._:-] */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

export const isDeviceId = (value: string): boolean => DEVICE_ID_PATTERN.test(value.trim())

/** 随机字节源：默认用 WebCrypto，取不到时退回 Math.random（老 WebView 兜底） */
export type RandomBytes = (length: number) => Uint8Array

const defaultRandomBytes: RandomBytes = (length) => {
  const bytes = new Uint8Array(length)
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes)
    return bytes
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  return bytes
}

const HEX = '0123456789abcdef'

/**
 * 生成设备码：`d-` + 32 位小写十六进制（共 34 位，落在 8–128 内）。
 * 前缀 `d-` 让人一眼看出这是设备码；字符集只用 [0-9a-f]，天然满足服务端白名单。
 */
export const createDeviceId = (randomBytes: RandomBytes = defaultRandomBytes): string => {
  const bytes = randomBytes(16)
  let text = 'd-'
  for (const byte of bytes) {
    text += HEX[(byte >> 4) & 0xf]
    text += HEX[byte & 0xf]
  }
  return text
}

/** 允许注入的最小存储接口（localStorage / 内存假对象都满足） */
export type DeviceIdStorage = {
  read: () => string | null
  write: (value: string) => void
}

export type DeviceIdState = {
  deviceId: string
  /** true = 本次新建（首次启动 / 存的值非法被重建） */
  created: boolean
}

/**
 * 读取或创建设备码。
 *
 * 已存的值**必须**通过字符集与长度校验才复用：老版本/手工改坏的值继续用会让服务端
 * 一直报参数错误，而且用户没法自救。非法值当作没有，重新生成并覆盖。
 */
export const loadOrCreateDeviceId = (
  storage: DeviceIdStorage,
  randomBytes: RandomBytes = defaultRandomBytes
): DeviceIdState => {
  const stored = (storage.read() ?? '').trim()
  if (isDeviceId(stored)) {
    return { deviceId: stored, created: false }
  }
  const deviceId = createDeviceId(randomBytes)
  storage.write(deviceId)
  return { deviceId, created: true }
}

/** localStorage 存储：读写失败（隐私模式 / 配额满）只当没有，不抛错、不写日志 */
export const localStorageDeviceIdStorage = (): DeviceIdStorage => ({
  read: () => {
    try {
      return localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    } catch {
      return null
    }
  },
  write: (value: string) => {
    try {
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, value)
    } catch {
      // 存不进去时仍然返回本次生成的设备码，用户可复制备份；下次启动会重新生成
    }
  },
})

/** 界面用的一次性入口：拿到（必要时新建）设备码 */
export const ensureDeviceId = (): string =>
  loadOrCreateDeviceId(localStorageDeviceIdStorage()).deviceId
