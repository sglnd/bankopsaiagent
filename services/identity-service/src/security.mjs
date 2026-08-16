import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const SCRYPT_OPTIONS = { N:16384, r:8, p:1, maxmem:64 * 1024 * 1024 }

export function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function validateUsername(value) {
  return /^[a-z][a-z0-9._-]{2,31}$/.test(value)
}

export function validatePassword(value) {
  const password = String(value ?? '')
  if (password.length < 9 || password.length > 128) return false

  const categoryCount = [
    /[A-Za-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9\s]/.test(password),
  ].filter(Boolean).length

  return categoryCount >= 2
}

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64, SCRYPT_OPTIONS)
  return { salt, hash:Buffer.from(derived).toString('hex') }
}

export async function verifyPassword(password, salt, expectedHex) {
  const { hash } = await hashPassword(password, salt)
  const actual = Buffer.from(hash, 'hex'), expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function opaqueToken(bytes = 32) { return randomBytes(bytes).toString('base64url') }
export function tokenHash(value) { return createHash('sha256').update(value).digest('hex') }

export function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(item => item.trim()).filter(Boolean).map(item => {
    const index = item.indexOf('=')
    return [decodeURIComponent(index < 0 ? item : item.slice(0,index)), decodeURIComponent(index < 0 ? '' : item.slice(index + 1))]
  }))
}

export function sessionCookies(sessionToken, csrfToken, { secure = false, maxAge = 28800 } = {}) {
  const common = `Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  return [
    `bankops_session=${encodeURIComponent(sessionToken)}; ${common}; HttpOnly`,
    `bankops_csrf=${encodeURIComponent(csrfToken)}; ${common}`,
  ]
}

export function clearSessionCookies({ secure = false } = {}) {
  const common = `Path=/; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
  return [`bankops_session=; ${common}; HttpOnly`, `bankops_csrf=; ${common}`]
}
