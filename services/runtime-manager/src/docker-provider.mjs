import http from 'node:http'

export class DockerProvider {
  constructor({ socketPath, network, image, environment = {}, stopTimeoutSeconds = 20 }) {
    this.socketPath = socketPath
    this.network = network
    this.image = image
    this.environment = environment
    this.stopTimeoutSeconds = stopTimeoutSeconds
  }

  request(method, path, body, accepted = [200,201,204,304]) {
    return new Promise((resolve,reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const request = http.request({ socketPath:this.socketPath, method, path, headers:payload ? {
        'content-type':'application/json','content-length':payload.length,
      } : {} }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8'), parsed = text ? JSON.parse(text) : undefined
          if (!accepted.includes(response.statusCode)) return reject(Object.assign(new Error(parsed?.message ?? `Docker API returned ${response.statusCode}`), { statusCode:response.statusCode, dockerBody:parsed }))
          resolve(parsed)
        })
      })
      request.on('error',reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  async ensureVolume(name, labels) {
    try { await this.request('GET', `/volumes/${encodeURIComponent(name)}/json`) }
    catch (error) {
      if (error.statusCode !== 404) throw error
      await this.request('POST','/volumes/create',{ Name:name,Labels:labels })
    }
  }

  async create(runtime) {
    const labels = { 'bankops.managed':'true','bankops.runtime-id':runtime.runtimeId,'bankops.tenant-id':runtime.tenantId,'bankops.user-id':runtime.userId }
    await this.ensureVolume(runtime.dshHomeVolume,{ ...labels,'bankops.volume-kind':'dsh-home' })
    await this.ensureVolume(runtime.workspaceVolume,{ ...labels,'bankops.volume-kind':'workspace' })
    const name = `bankops-runtime-${runtime.runtimeId}`
    const body = {
      Image:runtime.image ?? this.image,
      Env:Object.entries({ DSH_HOME:'/data/dsh',BANKOPS_USER_ID:runtime.userId,BANKOPS_TENANT_ID:runtime.tenantId,BANKOPS_WEB_PROXY:'1',...this.environment }).map(([key,value]) => `${key}=${value}`),
      Labels:labels,
      HostConfig:{
        Binds:[`${runtime.dshHomeVolume}:/data/dsh`,`${runtime.workspaceVolume}:/workspace`],
        NetworkMode:this.network,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],Init:true,
      },
    }
    try {
      const created = await this.request('POST',`/containers/create?name=${encodeURIComponent(name)}`,body)
      return { providerRuntimeId:created.Id,endpoint:{ network:this.network,containerName:name,port:3080 } }
    } catch (error) {
      if (error.statusCode !== 409) throw error
      const existing = await this.inspect(name)
      return { providerRuntimeId:existing.Id,endpoint:{ network:this.network,containerName:name,port:3080 } }
    }
  }

  async start(id) { await this.request('POST',`/containers/${encodeURIComponent(id)}/start`,undefined,[204,304]) }
  async stop(id) { await this.request('POST',`/containers/${encodeURIComponent(id)}/stop?t=${this.stopTimeoutSeconds}`,undefined,[204,304]) }
  async delete(id) { await this.request('DELETE',`/containers/${encodeURIComponent(id)}?force=false&v=false`,undefined,[204,404]) }
  async inspect(id) { return this.request('GET',`/containers/${encodeURIComponent(id)}/json`) }
}
