import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { config } from './config.mjs'
import { auditIdentity, ensureIdentitySchema, pool, ROLES } from './db.mjs'
import {
  clearSessionCookies, hashPassword, normalizeUsername, opaqueToken, parseCookies,
  sessionCookies, tokenHash, validatePassword, validateUsername, verifyPassword,
} from './security.mjs'

const JSON_HEADERS = { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...headers })
  response.end(`${JSON.stringify(body)}\n`)
}

async function readJson(request, limit = 32 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body is too large'), { statusCode:413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('request body must be valid JSON'), { statusCode:400 }) }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a,b)
}

function clientIp(request) {
  return String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress ?? '').split(',')[0].trim().slice(0,64)
}

async function loadUser(userId) {
  const result = await pool.query(
    `SELECT u.user_id,u.username,u.display_name,u.email,u.status,u.department_id,d.code AS department_code,d.name AS department_name,
       u.last_login_at,u.created_at,u.updated_at,COALESCE(array_agg(r.role_name) FILTER (WHERE r.role_name IS NOT NULL),'{}') AS roles
     FROM users u JOIN departments d ON d.tenant_id=u.tenant_id AND d.department_id=u.department_id
     LEFT JOIN user_roles r ON r.tenant_id=u.tenant_id AND r.user_id=u.user_id
     WHERE u.tenant_id=$1 AND u.user_id=$2 GROUP BY u.user_id,u.tenant_id,d.code,d.name`,
    [config.tenantId,userId],
  )
  return result.rows[0] ? publicUser(result.rows[0]) : null
}

function publicUser(row) {
  return {
    userId:row.user_id, username:row.username, displayName:row.display_name, email:row.email,
    status:row.status, department:{ id:row.department_id, code:row.department_code, name:row.department_name },
    roles:row.roles ?? [], lastLoginAt:row.last_login_at, createdAt:row.created_at, updatedAt:row.updated_at,
  }
}

async function authenticate(request, { csrf = false } = {}) {
  const cookies = parseCookies(request.headers.cookie), rawToken = cookies.bankops_session
  if (!rawToken) return null
  const result = await pool.query(
    `SELECT s.session_id,s.csrf_hash,s.expires_at,u.user_id,u.status
     FROM auth_sessions s JOIN users u ON u.tenant_id=s.tenant_id AND u.user_id=s.user_id
     WHERE s.tenant_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND s.expires_at>now()`,
    [config.tenantId,tokenHash(rawToken)],
  )
  const session = result.rows[0]
  if (!session || session.status !== 'ACTIVE') return null
  if (csrf) {
    const csrfHeader = request.headers['x-csrf-token'], csrfCookie = cookies.bankops_csrf
    if (!csrfHeader || !csrfCookie || !safeEqual(csrfHeader,csrfCookie) || !safeEqual(tokenHash(csrfHeader),session.csrf_hash)) {
      throw Object.assign(new Error('invalid CSRF token'), { statusCode:403, code:'csrf_failed' })
    }
  }
  await pool.query(`UPDATE auth_sessions SET last_seen_at=now() WHERE session_id=$1 AND last_seen_at<now()-interval '5 minutes'`, [session.session_id])
  return { sessionId:session.session_id, user:await loadUser(session.user_id) }
}

function requireRole(session, roles) {
  if (!session || !roles.some(role => session.user.roles.includes(role))) {
    throw Object.assign(new Error('insufficient permissions'), { statusCode:403, code:'forbidden' })
  }
}

async function register(request, response) {
  if (!config.registrationEnabled) return sendJson(response,403,{ error:'registration_disabled' })
  const input = await readJson(request), username = normalizeUsername(input.username), password = String(input.password ?? '')
  const displayName = String(input.displayName ?? '').trim(), departmentCode = String(input.departmentCode ?? '').trim().toUpperCase()
  const email = String(input.email ?? '').trim().toLowerCase()
  if (!validateUsername(username)) return sendJson(response,400,{ error:'invalid_username', message:'用户名须为 3-32 位小写字母、数字、点、下划线或短横线，且以字母开头' })
  if (!validatePassword(password)) return sendJson(response,400,{ error:'weak_password', message:'密码须为 9-128 位，并在字母、数字、特殊字符中至少包含两类' })
  if (displayName.length < 2 || displayName.length > 64) return sendJson(response,400,{ error:'invalid_display_name' })
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return sendJson(response,400,{ error:'invalid_email' })
  const department = await pool.query(`SELECT department_id FROM departments WHERE tenant_id=$1 AND code=$2 AND status='ACTIVE'`, [config.tenantId,departmentCode])
  if (!department.rowCount) return sendJson(response,400,{ error:'invalid_department' })
  const credentials = await hashPassword(password), userId = `usr_${randomUUID()}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO users(tenant_id,user_id,username,display_name,email,department_id,status,identity_provider)
      VALUES($1,$2,$3,$4,$5,$6,'PENDING','LOCAL')`,
    [config.tenantId,userId,username,displayName,email || null,department.rows[0].department_id])
    await client.query(`INSERT INTO local_identity_credentials(tenant_id,user_id,password_hash,password_salt) VALUES($1,$2,$3,$4)`,[config.tenantId,userId,credentials.hash,credentials.salt])
    await client.query(`INSERT INTO user_roles(tenant_id,user_id,role_name) VALUES($1,$2,'OPERATOR')`, [config.tenantId,userId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    if (error.code === '23505') return sendJson(response,409,{ error:'username_exists' })
    throw error
  } finally { client.release() }
  await auditIdentity({ action:'USER_REGISTER', targetUserId:userId, ipAddress:clientIp(request), details:{ username, departmentCode } })
  return sendJson(response,201,{ userId, username, status:'PENDING', message:'注册成功，等待平台管理员审批后即可登录' })
}

async function login(request, response) {
  const input = await readJson(request), username = normalizeUsername(input.username), password = String(input.password ?? '')
  const result = await pool.query(`SELECT u.*,c.password_hash,c.password_salt FROM users u LEFT JOIN local_identity_credentials c
    ON c.tenant_id=u.tenant_id AND c.user_id=u.user_id WHERE u.tenant_id=$1 AND lower(u.username)=$2`, [config.tenantId,username])
  const row = result.rows[0], passwordRecord = row ?? { password_salt:dummyCredentials.salt,password_hash:dummyCredentials.hash }
  const valid = passwordRecord.password_hash ? await verifyPassword(password,passwordRecord.password_salt,passwordRecord.password_hash) : false
  if (!row || !valid) {
    if (row) await pool.query(`UPDATE users SET failed_login_attempts=failed_login_attempts+1,
      locked_until=CASE WHEN failed_login_attempts+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END,
      status=CASE WHEN failed_login_attempts+1>=5 AND status='ACTIVE' THEN 'LOCKED' ELSE status END,updated_at=now()
      WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,row.user_id])
    await auditIdentity({ action:'USER_LOGIN', targetUserId:row?.user_id, outcome:'FAILURE', ipAddress:clientIp(request), details:{ username } })
    return sendJson(response,401,{ error:'invalid_credentials', message:'用户名或密码错误' })
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return sendJson(response,423,{ error:'account_locked', message:'登录失败次数过多，请稍后再试' })
  if (row.status === 'PENDING') return sendJson(response,403,{ error:'account_pending', message:'账户正在等待管理员审批' })
  if (!['ACTIVE','LOCKED'].includes(row.status)) return sendJson(response,403,{ error:'account_disabled', message:'账户已停用' })
  if (row.status === 'LOCKED') await pool.query(`UPDATE users SET status='ACTIVE',locked_until=NULL WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,row.user_id])
  const sessionToken = opaqueToken(), csrfToken = opaqueToken(), sessionId = randomUUID()
  await pool.query(`INSERT INTO auth_sessions(tenant_id,session_id,user_id,token_hash,csrf_hash,expires_at,ip_address,user_agent)
    VALUES($1,$2,$3,$4,$5,now()+($6::text||' hours')::interval,$7,$8)`,
  [config.tenantId,sessionId,row.user_id,tokenHash(sessionToken),tokenHash(csrfToken),config.sessionHours,clientIp(request),String(request.headers['user-agent'] ?? '').slice(0,500)])
  await pool.query(`UPDATE users SET failed_login_attempts=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,row.user_id])
  await auditIdentity({ actorUserId:row.user_id, action:'USER_LOGIN', targetUserId:row.user_id, ipAddress:clientIp(request) })
  return sendJson(response,200,{ user:await loadUser(row.user_id), csrfToken }, { 'set-cookie':sessionCookies(sessionToken,csrfToken,{ secure:config.cookieSecure,maxAge:config.sessionHours*3600 }) })
}

async function listUsers(url, response, session) {
  const params = [config.tenantId], filters = ['u.tenant_id=$1']
  if (!session.user.roles.includes('PLATFORM_ADMIN')) { params.push(session.user.department.id);filters.push(`u.department_id=$${params.length}`) }
  if (url.searchParams.get('status')) { params.push(url.searchParams.get('status')); filters.push(`u.status=$${params.length}`) }
  if (url.searchParams.get('departmentCode')) { params.push(url.searchParams.get('departmentCode')); filters.push(`d.code=$${params.length}`) }
  const result = await pool.query(
    `SELECT u.user_id,u.username,u.display_name,u.email,u.status,u.department_id,d.code AS department_code,d.name AS department_name,
       u.last_login_at,u.created_at,u.updated_at,COALESCE(array_agg(r.role_name) FILTER(WHERE r.role_name IS NOT NULL),'{}') AS roles
     FROM users u JOIN departments d ON d.tenant_id=u.tenant_id AND d.department_id=u.department_id
     LEFT JOIN user_roles r ON r.tenant_id=u.tenant_id AND r.user_id=u.user_id
     WHERE ${filters.join(' AND ')} GROUP BY u.user_id,u.tenant_id,d.code,d.name ORDER BY u.created_at DESC LIMIT 500`, params)
  sendJson(response,200,{ users:result.rows.map(publicUser) })
}

async function updateUser(request, response, session, userId) {
  const input = await readJson(request), status = input.status ? String(input.status).toUpperCase() : null
  const roles = input.roles ? [...new Set(input.roles.map(value => String(value).toUpperCase()))] : null
  if (status && !['PENDING','ACTIVE','DISABLED'].includes(status)) return sendJson(response,400,{ error:'invalid_status' })
  if (roles && roles.some(role => !ROLES.includes(role))) return sendJson(response,400,{ error:'invalid_role' })
  const platformAdmin = session.user.roles.includes('PLATFORM_ADMIN')
  const target = await loadUser(userId)
  if (!target) return sendJson(response,404,{ error:'user_not_found' })
  if (!platformAdmin && (target.department.id !== session.user.department.id || (input.departmentCode && String(input.departmentCode).toUpperCase() !== target.department.code) || roles?.some(role => role !== 'OPERATOR'))) {
    return sendJson(response,403,{ error:'department_admin_scope_exceeded' })
  }
  let departmentId = null
  if (input.departmentCode) {
    const dept = await pool.query(`SELECT department_id FROM departments WHERE tenant_id=$1 AND code=$2`, [config.tenantId,String(input.departmentCode).toUpperCase()])
    if (!dept.rowCount) return sendJson(response,400,{ error:'invalid_department' })
    departmentId = dept.rows[0].department_id
  }
  if (userId === session.user.userId && (status === 'DISABLED' || (roles && !roles.includes('PLATFORM_ADMIN')))) {
    return sendJson(response,409,{ error:'cannot_remove_own_admin_access' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const removesPlatformAdmin = target.roles.includes('PLATFORM_ADMIN') && (status === 'DISABLED' || (roles && !roles.includes('PLATFORM_ADMIN')))
    if (removesPlatformAdmin) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${config.tenantId}:platform-admins`])
      const admins = await client.query(`SELECT count(*)::integer AS count FROM users u JOIN user_roles r
        ON r.tenant_id=u.tenant_id AND r.user_id=u.user_id AND r.role_name='PLATFORM_ADMIN'
        WHERE u.tenant_id=$1 AND u.status='ACTIVE'`,[config.tenantId])
      if (admins.rows[0].count <= 1) { await client.query('ROLLBACK');return sendJson(response,409,{ error:'last_platform_admin' }) }
    }
    const updated = await client.query(`UPDATE users SET
      status=COALESCE($3,status),department_id=COALESCE($4,department_id),
      approved_by=CASE WHEN $3='ACTIVE' AND status='PENDING' THEN $5 ELSE approved_by END,
      approved_at=CASE WHEN $3='ACTIVE' AND status='PENDING' THEN now() ELSE approved_at END,updated_at=now()
      WHERE tenant_id=$1 AND user_id=$2 RETURNING user_id`, [config.tenantId,userId,status,departmentId,session.user.userId])
    if (!updated.rowCount) { await client.query('ROLLBACK'); return sendJson(response,404,{ error:'user_not_found' }) }
    if (roles) {
      await client.query(`DELETE FROM user_roles WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,userId])
      for (const role of roles) await client.query(`INSERT INTO user_roles(tenant_id,user_id,role_name,granted_by) VALUES($1,$2,$3,$4)`, [config.tenantId,userId,role,session.user.userId])
    }
    if (status === 'DISABLED') await client.query(`UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [config.tenantId,userId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await auditIdentity({ actorUserId:session.user.userId, action:'USER_UPDATE', targetUserId:userId, ipAddress:clientIp(request), details:{ status,roles,departmentId } })
  sendJson(response,200,{ user:await loadUser(userId) })
}

await ensureIdentitySchema()
await pool.query(`DELETE FROM auth_sessions WHERE expires_at<now()-interval '7 days' OR revoked_at<now()-interval '7 days'`)
const dummyCredentials=await hashPassword(opaqueToken())

const server = createServer(async (request,response) => {
  const requestId = String(request.headers['x-request-id'] ?? randomUUID())
  response.setHeader('x-request-id',requestId)
  try {
    const url = new URL(request.url,'http://identity.local')
    if (request.method === 'GET' && url.pathname === '/health') {
      await pool.query('SELECT 1')
      return sendJson(response,200,{ status:'ok',service:'bankops-identity' })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/auth/departments') {
      const result = await pool.query(`SELECT department_id,code,name FROM departments WHERE tenant_id=$1 AND status='ACTIVE' ORDER BY sort_order`, [config.tenantId])
      return sendJson(response,200,{ departments:result.rows.map(row => ({ departmentId:row.department_id,code:row.code,name:row.name })) })
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/auth/register') return register(request,response)
    if (request.method === 'POST' && url.pathname === '/api/v1/auth/login') return login(request,response)
    if (request.method === 'GET' && url.pathname === '/internal/v1/session') {
      const authorization = String(request.headers.authorization ?? '')
      if (!authorization.startsWith('Bearer ') || !safeEqual(authorization.slice(7),config.internalToken)) return sendJson(response,401,{ error:'unauthorized' })
      const session = await authenticate(request)
      return session ? sendJson(response,200,{ authenticated:true,user:session.user }) : sendJson(response,401,{ authenticated:false })
    }
    const csrfRequired = !['GET','HEAD'].includes(request.method ?? 'GET')
    const session = await authenticate(request,{ csrf:csrfRequired })
    if (!session) return sendJson(response,401,{ error:'unauthorized' })
    if (request.method === 'GET' && url.pathname === '/api/v1/auth/me') return sendJson(response,200,{ user:session.user })
    if (request.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
      await pool.query(`UPDATE auth_sessions SET revoked_at=now() WHERE session_id=$1`, [session.sessionId])
      await auditIdentity({ actorUserId:session.user.userId,action:'USER_LOGOUT',targetUserId:session.user.userId,ipAddress:clientIp(request) })
      return sendJson(response,200,{ loggedOut:true },{ 'set-cookie':clearSessionCookies({ secure:config.cookieSecure }) })
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/auth/change-password') {
      const input = await readJson(request), current = String(input.currentPassword ?? ''), next = String(input.newPassword ?? '')
      if (!validatePassword(next)) return sendJson(response,400,{ error:'weak_password', message:'密码须为 9-128 位，并在字母、数字、特殊字符中至少包含两类' })
      const currentUser = await pool.query(`SELECT password_hash,password_salt FROM local_identity_credentials WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,session.user.userId])
      if (!await verifyPassword(current,currentUser.rows[0].password_salt,currentUser.rows[0].password_hash)) return sendJson(response,401,{ error:'invalid_current_password' })
      const credentials = await hashPassword(next)
      await pool.query(`UPDATE local_identity_credentials SET password_hash=$3,password_salt=$4,password_changed_at=now() WHERE tenant_id=$1 AND user_id=$2`, [config.tenantId,session.user.userId,credentials.hash,credentials.salt])
      await pool.query(`UPDATE users SET updated_at=now() WHERE tenant_id=$1 AND user_id=$2`,[config.tenantId,session.user.userId])
      await pool.query(`UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND session_id<>$3`, [config.tenantId,session.user.userId,session.sessionId])
      await auditIdentity({ actorUserId:session.user.userId,action:'PASSWORD_CHANGE',targetUserId:session.user.userId,ipAddress:clientIp(request) })
      return sendJson(response,200,{ changed:true })
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/admin/users') {
      requireRole(session,['PLATFORM_ADMIN','DEPARTMENT_ADMIN'])
      return listUsers(url,response,session)
    }
    const userMatch = /^\/api\/v1\/admin\/users\/(usr_[0-9a-f-]+)$/.exec(url.pathname)
    if (request.method === 'PATCH' && userMatch) {
      requireRole(session,['PLATFORM_ADMIN','DEPARTMENT_ADMIN'])
      return updateUser(request,response,session,userMatch[1])
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/admin/roles') {
      requireRole(session,['PLATFORM_ADMIN','DEPARTMENT_ADMIN'])
      return sendJson(response,200,{ roles:session.user.roles.includes('PLATFORM_ADMIN') ? ROLES : ['OPERATOR'] })
    }
    return sendJson(response,404,{ error:'not_found' })
  } catch (error) {
    console.error(`[identity] request=${requestId}`,error)
    return sendJson(response,error.statusCode ?? 500,{ error:error.code ?? 'internal_error',message:error.statusCode ? error.message : 'internal server error',requestId })
  }
})

server.listen(config.port,config.host,() => console.log(`[bankops-identity] ${config.host}:${config.port}`))
