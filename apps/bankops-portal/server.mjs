import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const apiBaseUrl = (process.env.BANKOPS_AGENT_API_URL ?? 'http://agent-api:8090').replace(/\/$/, '')
const fileServiceUrl = (process.env.BANKOPS_FILE_SERVICE_URL ?? 'http://bankops-file-service:8951').replace(/\/$/, '')
const knowledgeApiUrl = (process.env.BANKOPS_KNOWLEDGE_API_URL ?? 'http://bankops-knowledge-mcp:9052').replace(/\/$/, '')
const identityApiUrl = (process.env.BANKOPS_IDENTITY_API_URL ?? 'http://identity-service:8960').replace(/\/$/, '')
const identityInternalToken = process.env.BANKOPS_IDENTITY_INTERNAL_TOKEN ?? ''
const identitySigningSecret = process.env.BANKOPS_IDENTITY_SIGNING_SECRET ?? ''
const agentApiToken = process.env.BANKOPS_AGENT_API_TOKEN ?? ''
const tenantId = process.env.BANKOPS_TENANT_ID ?? 'tenant-local'
const dshUrl = (process.env.BANKOPS_DSH_URL ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const host = process.env.BANKOPS_PORTAL_HOST ?? '0.0.0.0'
const port = Number(process.env.BANKOPS_PORTAL_PORT ?? 8080)

if (identityInternalToken.length < 24 || identitySigningSecret.length < 32) {
  throw new Error('Portal identity internal token/signing secret are not configured securely')
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(`${JSON.stringify(value)}\n`)
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf('=')
    return [decodeURIComponent(value.slice(0,index)),decodeURIComponent(value.slice(index+1))]
  }))
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a,b)
}

async function currentSession(request) {
  const upstream = await fetch(`${identityApiUrl}/internal/v1/session`, {
    headers:{ authorization:`Bearer ${identityInternalToken}`, cookie:String(request.headers.cookie ?? ''), 'x-request-id':String(request.headers['x-request-id'] ?? '') },
  })
  if (!upstream.ok) return null
  return (await upstream.json()).user
}

function verifyCsrf(request) {
  if (['GET','HEAD','OPTIONS'].includes(request.method ?? 'GET')) return true
  const cookies = parseCookies(request.headers.cookie), header = request.headers['x-csrf-token']
  return Boolean(cookies.bankops_csrf && header && safeEqual(cookies.bankops_csrf,header))
}

function hasRole(user, ...roles) { return roles.some(role => user.roles.includes(role)) }

function authorizeApi(request, url, user) {
  const write = !['GET','HEAD','OPTIONS'].includes(request.method ?? 'GET')
  if (url.pathname.startsWith('/api/v1/admin/')) return hasRole(user,'PLATFORM_ADMIN','DEPARTMENT_ADMIN')
  if (url.pathname.startsWith('/api/v1/skills')) return !write || hasRole(user,'PLATFORM_ADMIN','SKILL_DEVELOPER')
  if (url.pathname.startsWith('/api/v1/files')) {
    return !write || hasRole(user,'PLATFORM_ADMIN','KNOWLEDGE_MANAGER')
  }
  if (write && (url.pathname.startsWith('/api/v1/change-impact-analyses') || url.pathname.startsWith('/api/v1/system-inspections'))) {
    return hasRole(user,'PLATFORM_ADMIN','OPERATOR')
  }
  return true
}

function signedIdentityHeaders(user) {
  const payload = Buffer.from(JSON.stringify({
    tenantId, userId:user.userId, departmentId:user.department.id,
    roles:user.roles, workspaceId:`user-${user.userId}`, issuedAt:Date.now(),
  })).toString('base64url')
  return { payload, signature:createHmac('sha256',identitySigningSecret).update(payload).digest('base64url') }
}

async function proxyApi(request, response, url, targetBaseUrl = apiBaseUrl, user = null) {
  const headers = new Headers()
  for (const name of ['content-type', 'idempotency-key', 'x-request-id', 'user-agent']) {
    const value = request.headers[name]
    if (value) headers.set(name, Array.isArray(value) ? value.join(',') : value)
  }
  if (targetBaseUrl === identityApiUrl) {
    if (request.headers.cookie) headers.set('cookie',String(request.headers.cookie))
    if (request.headers['x-csrf-token']) headers.set('x-csrf-token',String(request.headers['x-csrf-token']))
  }
  headers.set('x-forwarded-for',String(request.socket.remoteAddress ?? ''))
  if (targetBaseUrl === apiBaseUrl && agentApiToken) headers.set('authorization',`Bearer ${agentApiToken}`)
  if (user) {
    const identity = signedIdentityHeaders(user)
    headers.set('x-bankops-identity',identity.payload)
    headers.set('x-bankops-identity-signature',identity.signature)
  }
  const hasBody = !['GET', 'HEAD'].includes(request.method ?? 'GET')
  const upstream = await fetch(`${targetBaseUrl}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
  })
  const responseHeaders = {
    'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
  }
  for (const name of ['etag', 'location', 'x-request-id', 'idempotency-replayed']) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders[name] = value
  }
  const setCookies = upstream.headers.getSetCookie?.() ?? []
  if (setCookies.length) responseHeaders['set-cookie'] = setCookies
  response.writeHead(upstream.status, responseHeaders)
  if (!upstream.body) return response.end()
  for await (const chunk of upstream.body) response.write(chunk)
  response.end()
}

async function serveHtml(response, filename) {
  const path = join(root, filename)
  const metadata = await stat(path)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': metadata.size,
    'cache-control': 'no-store',
  })
  createReadStream(path).pipe(response)
}

async function serveJavaScript(response, filename) {
  const path = join(root,filename), metadata = await stat(path)
  response.writeHead(200,{ 'content-type':'application/javascript; charset=utf-8','content-length':metadata.size,'cache-control':'no-store' })
  createReadStream(path).pipe(response)
}

function serveConfig(response) {
  const config = JSON.stringify({ dshUrl })
  response.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(`window.BANKOPS_PORTAL_CONFIG = ${config};\n`)
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://portal.local')
    if (url.pathname === '/health') return sendJson(response, 200, { status: 'ok', apiBaseUrl, fileServiceUrl, knowledgeApiUrl, identityApiUrl, dshUrl })
    if (request.method === 'GET' && url.pathname === '/config.js') return serveConfig(response)
    if (request.method === 'GET' && url.pathname === '/auth-client.js') return serveJavaScript(response,'auth-client.js')
    if (url.pathname.startsWith('/api/v1/auth/')) return await proxyApi(request,response,url,identityApiUrl)
    if (request.method === 'GET' && ['/login','/login/'].includes(url.pathname)) return await serveHtml(response,'login.html')
    if (request.method === 'GET' && ['/register','/register/'].includes(url.pathname)) return await serveHtml(response,'register.html')
    const user = await currentSession(request)
    if (!user) {
      if (url.pathname.startsWith('/api/')) return sendJson(response,401,{ error:'unauthorized' })
      response.writeHead(302,{ location:`/login?next=${encodeURIComponent(url.pathname)}`,'cache-control':'no-store' })
      return response.end()
    }
    if (request.method === 'GET' && ['/admin/users','/admin/users/'].includes(url.pathname)) {
      if (!hasRole(user,'PLATFORM_ADMIN','DEPARTMENT_ADMIN')) return sendJson(response,403,{ error:'forbidden' })
      return await serveHtml(response,'users.html')
    }
    if (request.method === 'GET' && ['/account','/account/'].includes(url.pathname)) return await serveHtml(response,'account.html')
    if (request.method === 'GET' && ['/skill-studio','/skill-studio/'].includes(url.pathname) && !hasRole(user,'PLATFORM_ADMIN','SKILL_DEVELOPER')) {
      return sendJson(response,403,{ error:'forbidden' })
    }
    if (url.pathname.startsWith('/api/') && !verifyCsrf(request)) return sendJson(response,403,{ error:'csrf_failed' })
    if (url.pathname.startsWith('/api/') && !authorizeApi(request,url,user)) return sendJson(response,403,{ error:'forbidden' })
    if (url.pathname.startsWith('/api/v1/admin/')) return await proxyApi(request,response,url,identityApiUrl,user)
    if (url.pathname.startsWith('/api/v1/files') || url.pathname.startsWith('/api/v1/index-jobs') || url.pathname.startsWith('/api/v1/knowledge-contexts')) {
      return await proxyApi(request, response, url, fileServiceUrl, user)
    }
    if (url.pathname.startsWith('/api/v1/knowledge')) return await proxyApi(request, response, url, knowledgeApiUrl, user)
    if (url.pathname.startsWith('/api/')) return await proxyApi(request, response, url, apiBaseUrl, user)
    if (request.method === 'GET' && url.pathname === '/') return await serveHtml(response, 'index.html')
    if (request.method === 'GET' && ['/knowledge', '/knowledge/'].includes(url.pathname)) return await serveHtml(response, 'knowledge.html')
    if (request.method === 'GET' && ['/skill-studio', '/skill-studio/'].includes(url.pathname)) return await serveHtml(response, 'skill-studio.html')
    return sendJson(response, 404, { error: 'not_found' })
  } catch (error) {
    return sendJson(response, 502, { error: 'portal_upstream_error', message: String(error?.message ?? error) })
  }
})

server.listen(port, host, () => {
  console.log(`[bankops-portal] ${host}:${port} api=${apiBaseUrl}`)
})
