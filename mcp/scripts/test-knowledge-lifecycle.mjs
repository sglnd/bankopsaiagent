const fileBase = process.env.FILE_SERVICE_URL ?? 'http://127.0.0.1:8951'
const knowledgeBase = process.env.KNOWLEDGE_REST_URL ?? 'http://127.0.0.1:9052'
const marker = `LIFECYCLE_${Date.now()}`

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options)
  const body = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${url}: ${response.status} ${JSON.stringify(body)}`)
  return { response, body }
}

async function upload(path, content, idempotencyKey) {
  const form = new FormData()
  form.set('file', new Blob([content], { type:'text/markdown' }), 'lifecycle-test.md')
  form.set('title', 'Knowledge lifecycle transient test')
  form.set('classification', 'INTERNAL')
  form.set('allowedRoles', 'OPERATIONS')
  return jsonFetch(`${fileBase}${path}`, { method:'POST', headers:{'idempotency-key':idempotencyKey}, body:form })
}

async function waitJob(jobId) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const { body } = await jsonFetch(`${fileBase}/api/v1/index-jobs/${jobId}`)
    if (body.status === 'COMPLETED') return body
    if (body.status === 'FAILED') throw new Error(`job ${jobId} failed: ${body.lastError}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`job ${jobId} did not complete in time`)
}

const firstKey = `lifecycle-first-${marker}`
const first = await upload('/api/v1/files', `# Lifecycle v1\n\n${marker} first version`, firstKey)
const documentId = first.body.documentId
await waitJob(first.body.latestJob.jobId)

const secondKey = `lifecycle-second-${marker}`
const second = await upload(`/api/v1/files/${documentId}/versions`, `# Lifecycle v2\n\n${marker} second version attachment context`, secondKey)
await waitJob(second.body.latestJob.jobId)
const replay = await upload(`/api/v1/files/${documentId}/versions`, `ignored duplicate ${marker}`, secondKey)
if (replay.response.headers.get('idempotency-replayed') !== 'true' || replay.body.version !== '2') throw new Error('idempotency replay did not return version 2')

const context = await jsonFetch(`${fileBase}/api/v1/knowledge-contexts`, { method:'POST', headers:{'content-type':'application/json'},
  body:JSON.stringify({ name:'Lifecycle test context', attachments:[{ documentId, version:'2' }] }) })
const searched = await jsonFetch(`${knowledgeBase}/api/v1/knowledge/search?q=${encodeURIComponent(marker)}&contextId=${encodeURIComponent(context.body.contextId)}`)
if (!JSON.stringify(searched.body).includes('second version attachment context')) throw new Error('context-restricted search did not return version 2')

const reindex = await jsonFetch(`${fileBase}/api/v1/files/${documentId}/versions/2/reindex`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}' })
await waitJob(reindex.body.jobId)

for (const version of ['1','2']) {
  const deleted = await jsonFetch(`${fileBase}/api/v1/files/${documentId}/versions/${version}`, { method:'DELETE' })
  await waitJob(deleted.body.jobId)
}
await jsonFetch(`${fileBase}/api/v1/knowledge-contexts/${context.body.contextId}`, { method:'DELETE' })

console.log(`knowledge lifecycle succeeded: document=${documentId}, context=${context.body.contextId}, idempotency/version/index/search/reindex/delete verified`)
