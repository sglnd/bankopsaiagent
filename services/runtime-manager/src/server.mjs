import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { config } from './config.mjs'
import { DockerProvider } from './docker-provider.mjs'
import { RuntimeManager } from './manager.mjs'
import { RuntimeStore } from './store.mjs'

const JSON_HEADERS = { 'content-type':'application/json; charset=utf-8','cache-control':'no-store' }
function sendJson(response,status,body) { response.writeHead(status,JSON_HEADERS);response.end(`${JSON.stringify(body)}\n`) }
async function readJson(request) { const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>16384)throw Object.assign(new Error('request body too large'),{statusCode:413});chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw Object.assign(new Error('invalid JSON'),{statusCode:400})} }
function authorized(request,token) { const value=String(request.headers.authorization??'').replace(/^Bearer /,'');const a=Buffer.from(value),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b) }

export function createRuntimeApi({ manager, store, token }) {
  const server=createServer(async(request,response)=>{
    response.setHeader('x-request-id',String(request.headers['x-request-id']??randomUUID()))
    try {
      const url=new URL(request.url,'http://runtime-manager.local')
      if(request.method==='GET'&&url.pathname==='/health'){await store.health();return sendJson(response,200,{status:'ok',service:'bankops-runtime-manager'})}
      if(!authorized(request,token))return sendJson(response,401,{error:'unauthorized'})
      if(request.method==='POST'&&url.pathname==='/api/v1/runtimes'){
        const input=await readJson(request),result=await manager.ensure({tenantId:input.tenantId,userId:input.userId,start:input.start!==false})
        return sendJson(response,result.created?201:200,result)
      }
      const match=/^\/api\/v1\/runtimes\/([0-9a-f-]{36})(?:\/(start|stop))?$/.exec(url.pathname)
      if(match&&request.method==='GET'&&!match[2]){const runtime=await manager.get(match[1]);return runtime?sendJson(response,200,{runtime}):sendJson(response,404,{error:'runtime_not_found'})}
      if(match&&request.method==='POST'&&match[2]){const runtime=match[2]==='start'?await manager.start(match[1]):await manager.stop(match[1]);return sendJson(response,200,{runtime})}
      if(match&&request.method==='DELETE'&&!match[2]){const runtime=await manager.delete(match[1]);return sendJson(response,200,{runtime,volumesPreserved:true})}
      sendJson(response,404,{error:'not_found'})
    }catch(error){console.error(error);sendJson(response,error.statusCode>=400&&error.statusCode<500?error.statusCode:500,{error:error.statusCode===404?'runtime_not_found':'runtime_operation_failed',message:error.message})}
  })
  return server
}

export async function startRuntimeManager(options={}) {
  const token=options.token??config.internalToken
  if(token.length<24)throw new Error('BANKOPS_RUNTIME_INTERNAL_TOKEN must contain at least 24 characters')
  const store=options.store??new RuntimeStore(config.databaseUrl);await store.initialize?.()
  const provider=options.provider??new DockerProvider({socketPath:config.dockerSocket,network:config.dockerNetwork,image:config.image,environment:config.runtimeEnvironment,stopTimeoutSeconds:config.stopTimeoutSeconds})
  const manager=options.manager??new RuntimeManager({store,provider,image:config.image,dshVersion:config.dshVersion,providerName:config.provider})
  const server=createRuntimeApi({manager,store,token})
  if(options.listen!==false)await new Promise(resolve=>server.listen(config.port,config.host,resolve))
  return {server,store,provider,manager}
}

if(import.meta.url===pathToFileURL(process.argv[1]).href){await startRuntimeManager();console.log(`BankOps Runtime Manager listening on http://${config.host}:${config.port}`)}
