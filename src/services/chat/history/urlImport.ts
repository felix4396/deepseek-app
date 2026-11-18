import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { errorMeta, record, recordAction, recordEvent, redactUrl } from '../../diagnostics/collector.js'
import { importHistory } from '../backup.js'
import { fail } from './errors.js'

/**
 * 直链导入：用原生 HTTP 下载 ZIP 后交给既有的文件导入链路（importHistory）。
 *
 * 为什么只能在原生（APK）里做：DeepSeek 导出的 ZIP 放在官方 OBS 桶上，桶没有开 CORS
 * （预检 OPTIONS 返回 403、响应无 Access-Control-Allow-Origin），浏览器 fetch 必被拦。
 * CapacitorHttp 走的是原生网络栈（Android 的 HttpURLConnection），不受 CORS 限制。
 */

/** 单个导出包的大小上限。官方包约 20MB、467 条目，留十倍余量，同时避免整包读进内存。 */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

/** 上限的 MB 数，用于提示文案。 */
const maxMegabytes = MAX_ARCHIVE_BYTES / 1024 / 1024

/** 交给 importHistory 的文件名，只用于提示与暂存，不写盘。 */
const ARCHIVE_NAME = 'deepseek_data.zip'

/** ZIP 本地文件头 PK\x03\x04，与 zipReader.isZipFile 保持一致。 */
const ZIP_MAGIC = [0x50, 0x4b, 3, 4]

/** 取消后丢弃结果：CapacitorHttp 不支持 abort，取消只保证「不再写入任何数据」。 */
export class UrlImportCancelled extends Error {
  constructor() {
    super('URL import cancelled')
    this.name = 'UrlImportCancelled'
  }
}

/** 原生（APK）才具备绕过 CORS 的原生 HTTP；网页版不提供该能力。 */
export const canImportFromUrl = (): boolean => Capacitor.isNativePlatform()

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= ZIP_MAGIC.length && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new UrlImportCancelled()
  }
}

/** 响应头大小写不固定（Android 侧原样返回服务端头），按小写名字取。 */
const headerValue = (
  headers: Record<string, string> | undefined,
  name: string
): string | undefined => {
  if (!headers) {
    return undefined
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name)
  return key === undefined ? undefined : String(headers[key])
}

/** 响应头里的 Content-Length；拿不到（chunked / 被网关去掉）时返回 undefined。 */
const contentLength = (headers: Record<string, string> | undefined): number | undefined => {
  const raw = headerValue(headers, 'content-length')
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

const tooLarge = (): never => fail('historyImportUrlTooLarge', { size: maxMegabytes })

/** 每批解码的 base64 字符数：约 3MB 输出，避免一次性生成几十 MB 的二进制字符串。 */
const DECODE_CHUNK_CHARS = 4 * 1024 * 1024

/**
 * base64 → 字节。实测（Android CapacitorHttp，见 tests/test.url-import-device.spec.mjs）
 * arraybuffer 的 data 是 base64 字符串，Web 实现的 CapacitorHttp 也一样。
 *
 * 分块解码：20MB 的包 base64 后约 28MB，一次性 atob 会再生成一个 ~21MB 的二进制字符串，
 * 低内存手机上容易把 WebView 渲染进程挤爆（模拟器上实测会崩），所以按块解码并只保留结果字节。
 */
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  // 输出长度上限按 3/4 估（比实际略大，最后按写入量截断）；Android 的 Base64.DEFAULT 每 76 字符插 \n。
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4) + 3)
  let written = 0
  let carry = ''
  for (let start = 0; start < value.length; start += DECODE_CHUNK_CHARS) {
    const chunk = (carry + value.slice(start, start + DECODE_CHUNK_CHARS)).replace(/\s/g, '')
    // 只解码完整的 4 字符组，剩下的留给下一批，避免 atob 报错。
    const usable = chunk.length - (chunk.length % 4)
    carry = chunk.slice(usable)
    if (usable === 0) {
      continue
    }
    const binary = atob(chunk.slice(0, usable))
    for (let index = 0; index < binary.length; index += 1) {
      bytes[written + index] = binary.charCodeAt(index)
    }
    written += binary.length
  }
  // 用 subarray 而不是 slice：多出的几十 KB 空闲字节不值得再复制一份 20MB 数据。
  return written === bytes.length ? bytes : bytes.subarray(0, written)
}

/** 统一 data → 字节，并在解码前先按 base64 长度估算一次大小。 */
const toBytes = (data: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof data === 'string') {
    // 每个 base64 字符约 3/4 字节：超限的包不必解码，避免几十 MB 的字符串再膨胀一倍。
    if (Math.floor((data.length * 3) / 4) > MAX_ARCHIVE_BYTES) {
      tooLarge()
    }
    return fromBase64(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
  }
  return fail('historyImportUrlBadResponse')
}

const isTimeout = (error: unknown): boolean =>
  /timeout|timed out|time out/i.test(error instanceof Error ? error.message : String(error))

/** 下发请求：网络失败与超时在这里分类，其余错误原样抛出由调用方处理。 */
const requestArchive = async (url: string): Promise<HttpResponse> => {
  const startedAt = Date.now()
  recordEvent('import_stage', 'import: download archive', {
    stage: 'download',
    'url.path': redactUrl(url),
  })
  try {
    return await CapacitorHttp.get({
      url,
      responseType: 'arraybuffer',
      connectTimeout: 30_000,
      readTimeout: 180_000,
      headers: { Accept: 'application/zip,application/octet-stream,*/*' },
    })
  } catch (error) {
    const timeout = isTimeout(error)
    // 失败必录：阶段 + 耗时 + 错误原文（下载失败是导入失败最常见的一类）
    record('import_error', 'error', `import download failed: ${timeout ? 'timeout' : 'network'}`, {
      stage: 'download',
      'url.path': redactUrl(url),
      durationMs: Date.now() - startedAt,
      reason: timeout ? 'timeout' : 'network',
      ...errorMeta(error),
    })
    return fail(timeout ? 'historyImportUrlTimeout' : 'historyImportUrlNetwork')
  }
}

/**
 * 下载并校验 ZIP，返回可直接交给 importHistory 的 File。
 * 失败分类：网络失败 / 超时 / HTTP 状态异常 / 超限 / 不是 ZIP / 数据无法解析。
 */
const downloadArchive = async (url: string, signal?: AbortSignal): Promise<File> => {
  const response = await requestArchive(url)
  throwIfCancelled(signal)
  if (response.status !== 200) {
    // 403 / 404 / 5xx：状态码必须落进日志，否则「导入没反应」无从查起
    record('import_error', 'error', `import download failed: HTTP ${response.status}`, {
      stage: 'download',
      'http.status': response.status,
      'url.path': redactUrl(url),
      'error.msg': `HTTP ${response.status}`,
    })
    fail('historyImportUrlHttp', { status: response.status })
  }
  // 先看响应头，超限就连 base64 都不解码。
  const declared = contentLength(response.headers)
  if (declared !== undefined && declared > MAX_ARCHIVE_BYTES) {
    tooLarge()
  }
  // 尽早放开响应里的 base64 字符串引用：解码时还要再占一份等大的内存。
  let data: unknown = response.data
  response.data = null
  const bytes = toBytes(data)
  data = null
  if (bytes.byteLength === 0) {
    fail('historyImportUrlBadResponse')
  }
  // 响应头缺失或不实时（chunked、网关改写）时，按实际字节数再判一次。
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    tooLarge()
  }
  if (!isZip(bytes)) {
    fail('historyImportUrlNotZip')
  }
  return new File([bytes], ARCHIVE_NAME, { type: 'application/zip' })
}

/**
 * 直链导入：校验 URL → 原生下载 → 校验 ZIP → 交给 importHistory（覆盖导入需调用方先确认）。
 * 取消后不写入任何数据：下载完成后再检查一次 signal，取消则丢弃已下载的内容。
 */
export const importHistoryFromUrl = async (
  url: string,
  options: { signal?: AbortSignal } = {}
): Promise<number> => {
  if (!Capacitor.isNativePlatform()) {
    record('import_error', 'error', 'import rejected: not native', {
      stage: 'validate',
      'error.msg': 'native platform required',
    })
    fail('historyImportUrlNativeOnly')
  }
  const link = url.trim()
  if (!/^https?:\/\/\S+$/i.test(link)) {
    record('import_error', 'error', 'import rejected: invalid url', {
      stage: 'validate',
      'url.path': redactUrl(link),
      'error.msg': 'invalid http(s) url',
    })
    fail('historyImportUrlInvalid')
  }
  recordAction('import_start', 'import-history-url', { source: 'url', 'url.path': redactUrl(link) })
  const file = await downloadArchive(link, options.signal)
  // 下载期间点了取消：结果直接丢弃，不进入暂存与替换事务。
  throwIfCancelled(options.signal)
  return importHistory(file)
}
