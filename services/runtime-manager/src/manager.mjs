import { randomUUID } from 'node:crypto'

function volumeToken(tenantId, userId) {
  const value = `${tenantId}-${userId}`.toLowerCase().replace(/[^a-z0-9_.-]+/g,'-').replace(/^-+|-+$/g,'')
  if (!value || value.length > 96) throw Object.assign(new Error('tenantId and userId produce an invalid volume name'), { statusCode:400 })
  return value
}

export class RuntimeManager {
  constructor({ store, provider, image, dshVersion, providerName = 'docker' }) {
    Object.assign(this,{ store,provider,image,dshVersion,providerName })
  }

  async ensure({ tenantId, userId, start = true }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(tenantId ?? '') || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(userId ?? '')) {
      throw Object.assign(new Error('tenantId and userId must be valid identifiers'), { statusCode:400 })
    }
    const runtimeId = randomUUID(), token = volumeToken(tenantId,userId)
    const result = await this.store.createOrGet({ runtimeId,tenantId,userId,provider:this.providerName,
      desiredStatus:start?'RUNNING':'STOPPED',image:this.image,dshVersion:this.dshVersion,
      dshHomeVolume:`bankops-dsh-home-${token}`,workspaceVolume:`bankops-workspace-${token}` })
    let runtime = result.runtime
    if (result.created) {
      try {
        const provisioned = await this.provider.create(runtime)
        runtime = await this.store.update(runtime.runtimeId,{ ...provisioned,status:'STOPPED',lastError:null,stopped:true })
        await this.record(runtime,'CREATE','SUCCESS')
      } catch (error) {
        await this.store.update(runtime.runtimeId,{ status:'ERROR',lastError:error.message })
        await this.record(runtime,'CREATE','FAILURE',{ message:error.message })
        throw error
      }
    }
    if (start && runtime.status !== 'RUNNING') runtime = await this.start(runtime.runtimeId)
    return { runtime,created:result.created }
  }

  async get(runtimeId, { refresh = true } = {}) {
    let runtime = await this.store.get(runtimeId)
    if (!runtime || runtime.deletedAt) return undefined
    if (refresh && runtime.providerRuntimeId) {
      try {
        const details = await this.provider.inspect(runtime.providerRuntimeId)
        const status = details.State?.Running ? 'RUNNING' : 'STOPPED'
        if (status !== runtime.status) runtime = await this.store.update(runtimeId,{ status })
      } catch (error) {
        if (error.statusCode === 404) runtime = await this.store.update(runtimeId,{ status:'ERROR',lastError:'provider runtime is missing' })
        else throw error
      }
    }
    return runtime
  }

  async start(runtimeId) {
    let runtime = await this.get(runtimeId,{ refresh:false })
    if (!runtime) throw Object.assign(new Error('runtime not found'),{ statusCode:404 })
    await this.store.update(runtimeId,{ desiredStatus:'RUNNING',status:'STARTING',lastError:null })
    try {
      await this.provider.start(runtime.providerRuntimeId)
      runtime = await this.store.update(runtimeId,{ status:'RUNNING',desiredStatus:'RUNNING',started:true,lastError:null })
      await this.record(runtime,'START','SUCCESS'); return runtime
    } catch (error) {
      await this.store.update(runtimeId,{ status:'ERROR',lastError:error.message })
      await this.record(runtime,'START','FAILURE',{ message:error.message }); throw error
    }
  }

  async stop(runtimeId) {
    let runtime = await this.get(runtimeId,{ refresh:false })
    if (!runtime) throw Object.assign(new Error('runtime not found'),{ statusCode:404 })
    await this.store.update(runtimeId,{ desiredStatus:'STOPPED',status:'STOPPING' })
    await this.provider.stop(runtime.providerRuntimeId)
    runtime = await this.store.update(runtimeId,{ status:'STOPPED',desiredStatus:'STOPPED',stopped:true,lastError:null })
    await this.record(runtime,'STOP','SUCCESS'); return runtime
  }

  async delete(runtimeId) {
    let runtime = await this.get(runtimeId,{ refresh:false })
    if (!runtime) throw Object.assign(new Error('runtime not found'),{ statusCode:404 })
    if (runtime.status === 'RUNNING') runtime = await this.stop(runtimeId)
    await this.provider.delete(runtime.providerRuntimeId)
    runtime = await this.store.update(runtimeId,{ status:'DELETED',desiredStatus:'DELETED',deleted:true })
    await this.record(runtime,'DELETE','SUCCESS',{ volumesPreserved:true }); return runtime
  }

  async record(runtime, action, outcome, details = {}) {
    await this.store.event({ eventId:randomUUID(),runtimeId:runtime.runtimeId,tenantId:runtime.tenantId,userId:runtime.userId,action,outcome,details })
  }
}
