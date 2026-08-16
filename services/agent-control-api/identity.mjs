import { createHmac, timingSafeEqual } from 'node:crypto'

function safeEqual(left,right) {
  const a=Buffer.from(String(left)),b=Buffer.from(String(right))
  return a.length===b.length&&timingSafeEqual(a,b)
}

export function verifyIdentity(request, secret) {
  const payload=request.headers['x-bankops-identity'],signature=request.headers['x-bankops-identity-signature']
  if (!payload&&!signature) return null
  if (!payload||!signature||!secret||secret.length<32) throw Object.assign(new Error('invalid identity context'),{ statusCode:401 })
  const expected=createHmac('sha256',secret).update(String(payload)).digest('base64url')
  if (!safeEqual(expected,signature)) throw Object.assign(new Error('invalid identity signature'),{ statusCode:401 })
  let identity
  try { identity=JSON.parse(Buffer.from(String(payload),'base64url').toString('utf8')) } catch { throw Object.assign(new Error('invalid identity payload'),{ statusCode:401 }) }
  if (!identity.userId||!identity.tenantId||!Array.isArray(identity.roles)||Math.abs(Date.now()-Number(identity.issuedAt))>60_000) {
    throw Object.assign(new Error('expired or incomplete identity context'),{ statusCode:401 })
  }
  return identity
}

export function requireIdentityRole(identity,roles) {
  if (identity&&!roles.some(role=>identity.roles.includes(role))) throw Object.assign(new Error('insufficient permissions'),{ statusCode:403 })
}
