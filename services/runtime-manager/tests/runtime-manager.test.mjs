import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { RuntimeManager } from '../src/manager.mjs'
import { createRuntimeApi } from '../src/server.mjs'

class FakeStore {
  constructor() { this.runtimes=new Map();this.users=new Map();this.events=[] }
  async health() {}
  async createOrGet(input) {
    const key=`${input.tenantId}:${input.userId}`,existing=this.users.get(key)
    if(existing)return {runtime:this.runtimes.get(existing),created:false}
    const runtime={...input,status:'PROVISIONING',providerRuntimeId:null,deletedAt:null}
    this.runtimes.set(input.runtimeId,runtime);this.users.set(key,input.runtimeId)
    return {runtime,created:true}
  }
  async get(id){return this.runtimes.get(id)}
  async update(id,patch){const current=this.runtimes.get(id),next={...current,...patch};if(patch.deleted)next.deletedAt=new Date().toISOString();this.runtimes.set(id,next);return next}
  async event(event){this.events.push(event)}
}

class FakeProvider {
  constructor(){this.created=0;this.started=0;this.stopped=0;this.deleted=0;this.running=false}
  async create(runtime){this.created+=1;return {providerRuntimeId:`container-${runtime.runtimeId}`,endpoint:{containerName:`runtime-${runtime.runtimeId}`,port:3080}}}
  async start(){this.started+=1;this.running=true}
  async stop(){this.stopped+=1;this.running=false}
  async delete(){this.deleted+=1}
  async inspect(id){return {Id:id,State:{Running:this.running}}}
}

function setup(){const store=new FakeStore(),provider=new FakeProvider();return {store,provider,manager:new RuntimeManager({store,provider,image:'bankops/dsh:rc7',dshVersion:'rc7'})}}

test('provisions one persistent runtime per tenant user and starts it',async()=>{
  const {manager,store,provider}=setup()
  const first=await manager.ensure({tenantId:'tenant-one',userId:'usr_123',start:true})
  const second=await manager.ensure({tenantId:'tenant-one',userId:'usr_123',start:true})
  assert.equal(first.created,true);assert.equal(second.created,false)
  assert.equal(first.runtime.status,'RUNNING');assert.equal(provider.created,1);assert.equal(provider.started,1)
  assert.equal(first.runtime.dshHomeVolume,'bankops-dsh-home-tenant-one-usr_123')
  assert.equal(first.runtime.workspaceVolume,'bankops-workspace-tenant-one-usr_123')
  assert.deepEqual(store.events.map(event=>event.action),['CREATE','START'])
})

test('stop, resume, and delete preserve the user volumes',async()=>{
  const {manager,provider}=setup(),created=await manager.ensure({tenantId:'tenant-one',userId:'usr_456',start:true})
  assert.equal((await manager.stop(created.runtime.runtimeId)).status,'STOPPED')
  assert.equal((await manager.start(created.runtime.runtimeId)).status,'RUNNING')
  const deleted=await manager.delete(created.runtime.runtimeId)
  assert.equal(deleted.status,'DELETED');assert.equal(provider.stopped,2);assert.equal(provider.deleted,1)
  assert.match(deleted.dshHomeVolume,/bankops-dsh-home-/);assert.match(deleted.workspaceVolume,/bankops-workspace-/)
})

const servers=[]
afterEach(async()=>Promise.all(servers.splice(0).map(server=>new Promise(resolve=>server.close(resolve)))))

test('HTTP API requires its internal token and exposes lifecycle operations',async()=>{
  const {manager,store}=setup(),token='runtime-manager-test-token-123'
  const server=createRuntimeApi({manager,store,token});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server)
  const base=`http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(`${base}/health`)).status,200)
  assert.equal((await fetch(`${base}/api/v1/runtimes`,{method:'POST'})).status,401)
  const created=await fetch(`${base}/api/v1/runtimes`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({tenantId:'tenant-one',userId:'usr_789'})})
  assert.equal(created.status,201);const body=await created.json();assert.equal(body.runtime.status,'RUNNING')
  const stopped=await fetch(`${base}/api/v1/runtimes/${body.runtime.runtimeId}/stop`,{method:'POST',headers:{authorization:`Bearer ${token}`}})
  assert.equal((await stopped.json()).runtime.status,'STOPPED')
})
