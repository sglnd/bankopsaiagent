const portal=process.env.BANKOPS_PORTAL_URL??'http://127.0.0.1:8080'
const adminUsername=process.env.BANKOPS_TEST_ADMIN_USERNAME??'admin'
const adminPassword=process.env.BANKOPS_TEST_ADMIN_PASSWORD??'BankOps@Local2026!'
const marker=Date.now(),username=`acceptance.network.${marker}`,password='Acceptance@Network2026!'

function cookies(response) { return response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ') }
async function json(path,options={}) {
  const response=await fetch(`${portal}${path}`,{redirect:'manual',...options})
  const body=await response.json().catch(()=>({}))
  return {response,body}
}
function assert(condition,message){if(!condition)throw new Error(message)}

const root=await fetch(`${portal}/`,{redirect:'manual'})
assert(root.status===302&&root.headers.get('location')?.startsWith('/login'),'unauthenticated portal did not redirect to login')
const departments=await json('/api/v1/auth/departments')
assert(departments.response.ok&&departments.body.departments.length===7,'expected seven departments')

const adminLogin=await json('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:adminUsername,password:adminPassword})})
assert(adminLogin.response.ok,'bootstrap administrator login failed')
const adminCookie=cookies(adminLogin.response),adminCsrf=adminLogin.body.csrfToken
const adminHeaders={cookie:adminCookie,'x-csrf-token':adminCsrf}
const adminMe=await json('/api/v1/auth/me',{headers:{cookie:adminCookie}})
assert(adminMe.body.user.roles.includes('PLATFORM_ADMIN'),'bootstrap user is not platform administrator')

const registration=await json('/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,displayName:'网络团队验收用户',departmentCode:'NETWORK',password})})
assert(registration.response.status===201&&registration.body.status==='PENDING','registration was not created pending approval')
const userId=registration.body.userId
const approval=await json(`/api/v1/admin/users/${userId}`,{method:'PATCH',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({status:'ACTIVE',departmentCode:'NETWORK',roles:['OPERATOR']})})
assert(approval.response.ok&&approval.body.user?.status==='ACTIVE',`administrator approval failed: ${approval.response.status} ${JSON.stringify(approval.body)}`)

const userLogin=await json('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})
assert(userLogin.response.ok,'approved operator login failed')
const userCookie=cookies(userLogin.response),userCsrf=userLogin.body.csrfToken
const forbiddenSkill=await json('/api/v1/skills',{method:'POST',headers:{cookie:userCookie,'x-csrf-token':userCsrf,'content-type':'application/json'},body:'{}'})
assert(forbiddenSkill.response.status===403,'operator unexpectedly modified skills')
const forbiddenFile=await json('/api/v1/files',{method:'POST',headers:{cookie:userCookie,'x-csrf-token':userCsrf,'content-type':'application/json'},body:'{}'})
assert(forbiddenFile.response.status===403,'operator unexpectedly uploaded knowledge')
const catalog=await json('/api/v1/mcp-catalog',{headers:{cookie:userCookie}})
assert(catalog.response.ok&&catalog.body.summary.serverCount===6,'operator could not read MCP catalog')

const disabled=await json(`/api/v1/admin/users/${userId}`,{method:'PATCH',headers:{...adminHeaders,'content-type':'application/json'},body:JSON.stringify({status:'DISABLED',departmentCode:'NETWORK',roles:['OPERATOR']})})
assert(disabled.response.ok&&disabled.body.user.status==='DISABLED','administrator could not disable user')
const revoked=await json('/api/v1/auth/me',{headers:{cookie:userCookie}})
assert(revoked.response.status===401,'disabled user session was not revoked')

console.log(`auth acceptance succeeded: departments=7, admin=${adminMe.body.user.username}, registration=PENDING, approval=ACTIVE, operator RBAC=verified, disable/revoke=verified, testUser=${username}`)
