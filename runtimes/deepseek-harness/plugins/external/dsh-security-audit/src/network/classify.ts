/**
 * 地址/URL 分类（设计 §7.4）：
 * - loopback：localhost、127.0.0.0/8、::1；
 * - unspecified bind：0.0.0.0、::；
 * - private/link-local 不是安全等价于 loopback（至少 medium/contextual）；
 * - v1 不主动解析 hostname（需要网络/DNS），仅按字面和 URL 结构分类；
 * - userinfo 视为秘密泄漏风险；
 * - allowlist 按规范化的 scheme+hostname+effective port 精确匹配，
 *   默认不允许 wildcard、路径前缀或 userinfo。
 */

export type AddressClass = 'loopback' | 'unspecified' | 'private' | 'external' | 'unknown'

export interface UrlClass {
  url: URL
  protocol: string
  hostname: string
  port: number
  addressClass: AddressClass
  hasUserinfo: boolean
  plaintext: boolean
}

export function classifyHostname(host: string): AddressClass {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '' || h === 'localhost' || h === 'localhost.localdomain' || h === '::1') return 'loopback'
  if (h === '0.0.0.0' || h === '::' || h === '[*]') return 'unspecified'
  if (/^127\./.test(h)) return 'loopback'
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return 'private'
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return 'private'
  if (/^fc|^fd/.test(h)) return 'private' // fc00::/7 (IPv6 unique local)
  if (/^fe[89ab]/.test(h)) return 'private' // fe80::/10 link-local
  if (/^[0-9a-f:]+$/.test(h)) return 'unknown' // 其它 IPv6 字面量
  return 'external'
}

export function classifyUrl(raw: string): UrlClass | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const protocol = url.protocol.toLowerCase()
  const addressClass = classifyHostname(hostname)
  const defaultPort = protocol === 'https:' || protocol === 'wss:' ? 443 : protocol === 'http:' || protocol === 'ws:' ? 80 : 0
  const port = url.port !== '' ? Number(url.port) : defaultPort
  return {
    url,
    protocol,
    hostname,
    port,
    addressClass,
    hasUserinfo: url.username !== '' || url.password !== '',
    plaintext: protocol === 'http:' || protocol === 'ws:',
  }
}

/** 规范化 endpoint：scheme://hostname:effectivePort（小写，无路径/query/userinfo）。 */
export function normalizeEndpoint(raw: string): string | null {
  const c = classifyUrl(raw)
  if (c === null) return null
  return `${c.protocol}//${c.hostname}:${c.port}`
}

/**
 * allowlist 精确匹配（设计 §7.4）：条目按规范化的 scheme+hostname+port 匹配，
 * 无 wildcard/路径前缀/userinfo；含 wildcard、路径、query、userinfo 的条目
 * 视为无效配置，永不匹配任何 URL。allowlist 仅降低"未知外部目标"规则。
 */
export function isAllowedEndpoint(raw: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false
  const norm = normalizeEndpoint(raw)
  if (norm === null) return false
  return allowlist.some((entry) => {
    // 无效条目（wildcard/路径/query/userinfo）永不匹配
    if (isInvalidAllowlistEntry(entry)) return false
    const e = normalizeEndpoint(entry)
    return e !== null && e === norm
  })
}

function isInvalidAllowlistEntry(entry: string): boolean {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    return true
  }
  if (url.username !== '' || url.password !== '') return true
  if (url.hostname.includes('*') || url.hostname.includes('?')) return true
  if (url.pathname !== '/' && url.pathname !== '') return true
  if (url.search !== '' || url.hash !== '') return true
  return false
}

/** 是否 loopback（含 unspecified 之外的安全判断）。 */
export function isLoopback(c: UrlClass): boolean {
  return c.addressClass === 'loopback'
}
