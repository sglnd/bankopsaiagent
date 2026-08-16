import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'

const fileBase = process.env.FILE_SERVICE_URL ?? 'http://127.0.0.1:8951'
const knowledgeBase = process.env.KNOWLEDGE_REST_URL ?? 'http://127.0.0.1:9052'
const inputs = process.argv.slice(2)
if (!inputs.length) throw new Error('usage: node test-document-parsers.mjs FILE.pdf FILE.docx')

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options), body = response.status === 204 ? null : await response.json()
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${url}: ${response.status} ${JSON.stringify(body)}`)
  return body
}

async function waitJob(jobId) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const body = await jsonFetch(`${fileBase}/api/v1/index-jobs/${jobId}`)
    if (body.status === 'COMPLETED') return body
    if (body.status === 'FAILED') throw new Error(`${jobId}: ${body.lastError}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`${jobId}: timeout`)
}

for (const path of inputs) {
  const extension = extname(path).toLowerCase()
  const mediaType = extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const form = new FormData()
  form.set('file', new Blob([await readFile(path)], { type:mediaType }), basename(path))
  form.set('title', `Parser smoke ${basename(path)}`)
  form.set('allowedRoles', 'OPERATIONS')
  const uploaded = await jsonFetch(`${fileBase}/api/v1/files`, { method:'POST', headers:{'idempotency-key':`parser-${extension.slice(1)}-${Date.now()}`}, body:form })
  const completed = await waitJob(uploaded.latestJob.jobId)
  if (completed.result?.parser !== extension.slice(1)) throw new Error(`${path}: expected ${extension.slice(1)} parser, got ${completed.result?.parser}`)
  const searched = await jsonFetch(`${knowledgeBase}/api/v1/knowledge/search?q=payment_api_p95_ms&limit=20`)
  if (!searched.matches.some(item => item.document_id === uploaded.documentId)) throw new Error(`${path}: indexed content not searchable`)
  const deleted = await jsonFetch(`${fileBase}/api/v1/files/${uploaded.documentId}/versions/1`, { method:'DELETE' })
  await waitJob(deleted.jobId)
  console.log(`${extension.slice(1)} parser succeeded: pages=${completed.result.pageCount}, chars=${completed.result.charCount}, chunks=${completed.result.chunkCount}`)
}
