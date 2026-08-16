const portal=process.env.BANKOPS_PORTAL_URL??'http://127.0.0.1:8080'
const username=process.env.BANKOPS_TEST_ADMIN_USERNAME??'admin'
const password=process.env.BANKOPS_TEST_ADMIN_PASSWORD??'BankOps@Local2026!'
function assert(value,message){if(!value)throw new Error(message)}
const login=await fetch(`${portal}/api/v1/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})
const loginBody=await login.json();assert(login.ok,'admin login failed')
const cookie=login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; '),csrf=loginBody.csrfToken
const page=await fetch(`${portal}/admin/users`,{headers:{cookie},redirect:'manual'});assert(page.ok,'user management page unavailable')
const account=await fetch(`${portal}/account`,{headers:{cookie},redirect:'manual'});assert(account.ok,'account page unavailable')
const users=await fetch(`${portal}/api/v1/admin/users`,{headers:{cookie}});const usersBody=await users.json();assert(users.ok&&Array.isArray(usersBody.users),'user list unavailable')
const files=await fetch(`${portal}/api/v1/files`,{headers:{cookie}});assert(files.ok,'signed identity file listing failed')
const catalog=await fetch(`${portal}/api/v1/mcp-catalog`,{headers:{cookie}});const catalogBody=await catalog.json();assert(catalog.ok&&catalogBody.summary.serverCount===6,'agent catalog unavailable')
const logout=await fetch(`${portal}/api/v1/auth/logout`,{method:'POST',headers:{cookie,'x-csrf-token':csrf}});assert(logout.ok,'logout failed')
const revoked=await fetch(`${portal}/api/v1/auth/me`,{headers:{cookie},redirect:'manual'});assert(revoked.status===401,'logout did not revoke session')
console.log(`admin smoke succeeded: users=${usersBody.users.length}, signed-file-access=ok, mcp-servers=${catalogBody.summary.serverCount}, logout-revocation=ok`)
