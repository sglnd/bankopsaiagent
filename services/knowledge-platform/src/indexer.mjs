import { createHash } from 'node:crypto'
import { getDocument, getDocumentAcl, pool } from './db.mjs'
import { esRequest, KNOWLEDGE_CHUNK_INDEX, KNOWLEDGE_DOCUMENT_INDEX } from './elasticsearch.mjs'
import { readObject, removeObject } from './storage.mjs'
import { chunkExtractedDocument, extractDocument } from './text.mjs'

function aclFields(acl) {
  return {
    allowed_user_ids:acl.filter(item => item.subject_type === 'USER').map(item => item.subject_id),
    allowed_department_ids:acl.filter(item => item.subject_type === 'DEPARTMENT').map(item => item.subject_id),
    allowed_roles:acl.filter(item => item.subject_type === 'ROLE').map(item => item.subject_id),
  }
}

async function removeDerivedIndex(tenantId, documentId, version) {
  await esRequest(`/${KNOWLEDGE_CHUNK_INDEX}/_delete_by_query?refresh=true&conflicts=proceed`, { method:'POST', body:JSON.stringify({ query:{ bool:{ filter:[
    { term:{ tenant_id:tenantId } }, { term:{ document_id:documentId } }, { term:{ document_version:version } },
  ] } } }) })
  const metadataId = encodeURIComponent(`${tenantId}:${documentId}:${version}`)
  const response = await fetch(`${process.env.ELASTICSEARCH_URL ?? 'http://elasticsearch:9200'}/${KNOWLEDGE_DOCUMENT_INDEX}/_doc/${metadataId}?refresh=true`, {
    method:'DELETE', signal:AbortSignal.timeout(15_000),
  })
  if (!response.ok && response.status !== 404) throw new Error(`Elasticsearch metadata delete ${response.status}: ${(await response.text()).slice(0, 500)}`)
}

export async function indexDocument(job) {
  const document = await getDocument(job.tenant_id, job.document_id, job.document_version)
  if (!document) throw new Error('document metadata not found')
  if (document.status === 'DELETED') return { skipped:true, reason:'document_deleted' }
  await pool.query(`UPDATE documents SET status='INDEXING', index_error=NULL WHERE tenant_id=$1 AND document_id=$2 AND version=$3`,
    [job.tenant_id, job.document_id, job.document_version])
  const acl = await getDocumentAcl(job.tenant_id, job.document_id, job.document_version)
  const bytes = await readObject(document.minio_bucket, document.minio_object_key)
  const filename = document.filename || document.minio_object_key.split('/').pop()
  const extracted = await extractDocument(bytes, document.media_type, filename)
  const chunks = chunkExtractedDocument(extracted)
  if (!chunks.length) throw new Error('document produced no searchable chunks')
  const access = aclFields(acl)
  await removeDerivedIndex(job.tenant_id, document.document_id, document.version)
  const now = new Date().toISOString(), bulkLines = []
  chunks.forEach((chunk, index) => {
    const chunkId = createHash('sha256').update(`${document.document_id}:${document.version}:${index}:${chunk.content}`).digest('hex')
    bulkLines.push(JSON.stringify({ index:{ _index:KNOWLEDGE_CHUNK_INDEX, _id:chunkId } }))
    const source = { chunk_id:chunkId, document_id:document.document_id, document_version:document.version, tenant_id:job.tenant_id,
      title:document.title, section:chunk.pageNumber ? `第 ${chunk.pageNumber} 页` : `片段 ${index + 1}`, content:chunk.content,
      chunk_order:index, ...access, classification:document.classification, content_sha256:document.content_sha256, created_at:now }
    if (chunk.pageNumber) source.page_number = chunk.pageNumber
    bulkLines.push(JSON.stringify(source))
  })
  const bulk = await esRequest('/_bulk?refresh=true', { method:'POST', headers:{'content-type':'application/x-ndjson'}, body:`${bulkLines.join('\n')}\n` })
  if (bulk.errors) {
    const failure = bulk.items.find(item => item.index?.error)?.index?.error
    throw new Error(`Elasticsearch bulk index failed: ${JSON.stringify(failure).slice(0, 800)}`)
  }
  const indexedAt = new Date().toISOString()
  await esRequest(`/${KNOWLEDGE_DOCUMENT_INDEX}/_doc/${encodeURIComponent(`${job.tenant_id}:${document.document_id}:${document.version}`)}?refresh=true`, {
    method:'PUT', body:JSON.stringify({ document_id:document.document_id, version:document.version, title:document.title, status:'PUBLISHED',
      classification:document.classification, tenant_id:job.tenant_id, owner_department_id:document.owner_department_id, ...access,
      minio_bucket:document.minio_bucket, minio_object_key:document.minio_object_key, content_sha256:document.content_sha256,
      media_type:document.media_type, created_at:document.created_at, published_at:indexedAt }),
  })
  await pool.query(`UPDATE documents SET status='PUBLISHED', published_at=COALESCE(published_at,$1), indexed_at=$1, index_error=NULL
    WHERE tenant_id=$2 AND document_id=$3 AND version=$4`, [indexedAt, job.tenant_id, document.document_id, document.version])
  return { status:'PUBLISHED', parser:extracted.kind, pageCount:extracted.pages.length, charCount:extracted.charCount, chunkCount:chunks.length, warnings:extracted.warnings }
}

export async function deleteDocument(job) {
  const document = await getDocument(job.tenant_id, job.document_id, job.document_version)
  if (!document) return { skipped:true, reason:'document_not_found' }
  await pool.query(`UPDATE documents SET status='DELETING' WHERE tenant_id=$1 AND document_id=$2 AND version=$3`,
    [job.tenant_id, job.document_id, job.document_version])
  await removeDerivedIndex(job.tenant_id, document.document_id, document.version)
  await removeObject(document.minio_bucket, document.minio_object_key)
  await pool.query(`UPDATE documents SET status='DELETED', deleted_at=now(), index_error=NULL WHERE tenant_id=$1 AND document_id=$2 AND version=$3`,
    [job.tenant_id, job.document_id, job.document_version])
  return { status:'DELETED' }
}
