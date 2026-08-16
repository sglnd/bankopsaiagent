import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import multer from 'multer'
import { audit } from './audit.mjs'
import { actorContext, config } from './config.mjs'
import { canManageDocument, canReadDocument, ensurePlatformSchema, pool } from './db.mjs'
import { ActiveDocumentJobError, enqueueJob, publicJob } from './jobs.mjs'
import { putObject, removeObject } from './storage.mjs'
import { isIndexableMediaType } from './text.mjs'

const port = Number(process.env.PORT ?? 8951)
const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:config.maxUploadBytes, files:1, fields:20, parts:24 } })
const app = express()
app.use(express.json({ limit:'128kb' }))

function safeFilename(value) {
  return value.normalize('NFKC').replace(/[\/\\\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'upload.bin'
}

function parseCsv(value, fallback = []) {
  return typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : fallback
}

function requestId(request) {
  return String(request.headers['x-request-id'] || randomUUID()).slice(0, 128)
}

function requireKnowledgeManager(actor, request) {
  if (request.headers['x-bankops-identity'] && !actor.roles.some(role => ['PLATFORM_ADMIN','KNOWLEDGE_MANAGER'].includes(role))) {
    throw Object.assign(new Error('knowledge manager role required'),{ statusCode:403 })
  }
}

function publicDocument(row) {
  const latestJob = row.job_id ? publicJob({
    ...row,
    document_id:row.document_id,
    document_version:row.job_document_version,
    status:row.job_status,
    created_at:row.job_created_at,
    updated_at:row.job_updated_at,
  }) : undefined
  return {
    documentId:row.document_id, version:row.version, title:row.title, filename:row.filename,
    status:row.document_status ?? row.status, classification:row.classification, mediaType:row.media_type,
    sizeBytes:Number(row.size_bytes ?? 0), contentSha256:row.content_sha256,
    createdBy:row.created_by, createdAt:row.created_at, publishedAt:row.published_at,
    indexedAt:row.indexed_at, deletedAt:row.deleted_at, indexError:row.index_error,
    latestJob,
  }
}

async function findIdempotentUpload(actor, key) {
  if (!key) return null
  const result = await pool.query(
    `SELECT d.*, d.status AS document_status,
       j.job_id, j.document_version AS job_document_version, j.operation, j.status AS job_status,
       j.attempts, j.max_attempts, j.available_at, j.started_at, j.completed_at, j.last_error, j.result,
       j.created_at AS job_created_at, j.updated_at AS job_updated_at
     FROM documents d LEFT JOIN LATERAL (
       SELECT * FROM document_index_jobs WHERE tenant_id=d.tenant_id AND document_id=d.document_id AND document_version=d.version
       ORDER BY created_at DESC LIMIT 1
     ) j ON true WHERE d.tenant_id=$1 AND d.created_by=$2 AND d.idempotency_key=$3`,
    [actor.tenantId, actor.userId, key],
  )
  return result.rows[0] ?? null
}

async function uploadDocument(request, response, existingDocumentId = null) {
  if (!request.file) return response.status(400).json({ error:'file_required', message:'multipart field "file" is required' })
  const actor = actorContext(request), reqId = requestId(request)
  requireKnowledgeManager(actor,request)
  const idempotencyKey = String(request.headers['idempotency-key'] || '').trim() || null
  if (idempotencyKey && !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    return response.status(400).json({ error:'invalid_idempotency_key' })
  }
  const replay = await findIdempotentUpload(actor, idempotencyKey)
  if (replay) return response.status(200).set('idempotency-replayed','true').json(publicDocument(replay))
  if (existingDocumentId && !(await canManageDocument(actor, existingDocumentId))) return response.status(403).json({ error:'forbidden' })

  const documentId = existingDocumentId || `doc_${randomUUID()}`
  const filename = safeFilename(request.file.originalname)
  const mediaType = request.file.mimetype || 'application/octet-stream'
  const sha256 = createHash('sha256').update(request.file.buffer).digest('hex')
  const client = await pool.connect()
  let document
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${actor.tenantId}:${documentId}`])
    const previousResult = existingDocumentId
      ? await client.query(`SELECT * FROM documents WHERE tenant_id=$1 AND document_id=$2 ORDER BY version::integer DESC LIMIT 1`, [actor.tenantId, documentId])
      : { rows:[] }
    const previous = previousResult.rows[0]
    const version = String(previous ? Number(previous.version) + 1 : 1)
    const title = String(request.body.title || previous?.title || filename).trim().slice(0, 240)
    const classificationCandidate = request.body.classification || previous?.classification || 'INTERNAL'
    const classification = ['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].includes(classificationCandidate) ? classificationCandidate : 'INTERNAL'
    const ownerDepartmentId = String(request.body.ownerDepartmentId || previous?.owner_department_id || actor.departmentId).trim()
    const allowedRoles = parseCsv(request.body.allowedRoles, actor.roles)
    const objectKey = `${actor.tenantId}/${documentId}/${version}/${filename}`
    const inserted = await client.query(
      `INSERT INTO documents
       (tenant_id, document_id, version, title, filename, status, classification, owner_department_id,
        minio_bucket, minio_object_key, content_sha256, media_type, size_bytes, created_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'UPLOADING',$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [actor.tenantId, documentId, version, title, filename, classification, ownerDepartmentId,
        config.fileBucket, objectKey, sha256, mediaType, request.file.size, actor.userId, idempotencyKey],
    )
    document = inserted.rows[0]
    if (previous) {
      await client.query(
        `INSERT INTO document_acl (tenant_id, document_id, document_version, subject_type, subject_id, permission)
         SELECT tenant_id, document_id, $3, subject_type, subject_id, permission FROM document_acl
         WHERE tenant_id=$1 AND document_id=$2 AND document_version=$4 ON CONFLICT DO NOTHING`,
        [actor.tenantId, documentId, version, previous.version],
      )
    } else {
      const aclRows = [['USER',actor.userId,'MANAGE'],['DEPARTMENT',ownerDepartmentId,'READ'],...allowedRoles.map(role => ['ROLE',role,'READ'])]
      for (const [subjectType, subjectId, permission] of aclRows) {
        await client.query(
          `INSERT INTO document_acl (tenant_id,document_id,document_version,subject_type,subject_id,permission)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [actor.tenantId, documentId, version, subjectType, subjectId, permission],
        )
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    if (error.code === '23505' && idempotencyKey) {
      const existing = await findIdempotentUpload(actor, idempotencyKey)
      if (existing) return response.status(200).set('idempotency-replayed','true').json(publicDocument(existing))
    }
    await audit({ actor, action:'DOCUMENT_UPLOAD', resourceType:'DOCUMENT', resourceId:documentId, outcome:'FAILURE', requestId:reqId, details:{ error:error.message } })
    return response.status(409).json({ error:'document_metadata_failed', message:error.message })
  } finally { client.release() }

  try {
    await putObject(document.minio_bucket, document.minio_object_key, request.file.buffer, mediaType)
    let job
    if (isIndexableMediaType(mediaType, filename)) job = await enqueueJob({ tenantId:actor.tenantId, documentId, version:document.version, operation:'INDEX', createdBy:actor.userId })
    else await pool.query(`UPDATE documents SET status='STORED_ONLY', index_error='unsupported media type' WHERE tenant_id=$1 AND document_id=$2 AND version=$3`, [actor.tenantId, documentId, document.version])
    const current = await pool.query(`SELECT * FROM documents WHERE tenant_id=$1 AND document_id=$2 AND version=$3`, [actor.tenantId, documentId, document.version])
    await audit({ actor, action:existingDocumentId ? 'DOCUMENT_VERSION_UPLOAD':'DOCUMENT_UPLOAD', resourceType:'DOCUMENT', resourceId:documentId, requestId:reqId,
      details:{ version:document.version, filename, mediaType, sizeBytes:request.file.size, jobId:job?.job_id } })
    return response.status(202).json({ ...publicDocument(current.rows[0]), latestJob:job ? publicJob(job) : undefined })
  } catch (error) {
    await pool.query(`UPDATE documents SET status='FAILED', index_error=$1 WHERE tenant_id=$2 AND document_id=$3 AND version=$4`, [error.message, actor.tenantId, documentId, document.version])
    try { await removeObject(document.minio_bucket, document.minio_object_key) } catch {}
    await audit({ actor, action:'DOCUMENT_UPLOAD', resourceType:'DOCUMENT', resourceId:documentId, outcome:'FAILURE', requestId:reqId, details:{ error:error.message } })
    return response.status(502).json({ error:'file_store_failed', message:error.message })
  }
}

app.get('/health', async (_request, response) => {
  try { await pool.query('SELECT 1'); response.json({ status:'ok', service:'bankops-file-service', bucket:config.fileBucket, maxUploadBytes:config.maxUploadBytes }) }
  catch (error) { response.status(503).json({ status:'error', message:error.message }) }
})

app.get('/api/v1/files', async (request, response) => {
  const actor = actorContext(request)
  const result = await pool.query(
    `SELECT d.*, d.status AS document_status,
       j.job_id, j.document_version AS job_document_version, j.operation, j.status AS job_status,
       j.attempts, j.max_attempts, j.available_at, j.started_at, j.completed_at, j.last_error, j.result,
       j.created_at AS job_created_at, j.updated_at AS job_updated_at
     FROM documents d LEFT JOIN LATERAL (
       SELECT * FROM document_index_jobs WHERE tenant_id=d.tenant_id AND document_id=d.document_id AND document_version=d.version
       ORDER BY created_at DESC LIMIT 1
     ) j ON true WHERE d.tenant_id=$1 AND d.status <> 'DELETED'
     AND (d.created_by=$2 OR EXISTS (SELECT 1 FROM document_acl a WHERE a.tenant_id=d.tenant_id AND a.document_id=d.document_id
       AND a.document_version=d.version AND ((a.subject_type='USER' AND a.subject_id=$2)
       OR (a.subject_type='DEPARTMENT' AND a.subject_id=$3) OR (a.subject_type='ROLE' AND a.subject_id=ANY($4::text[])))))
     ORDER BY d.created_at DESC LIMIT 200`, [actor.tenantId, actor.userId, actor.departmentId, actor.roles],
  )
  response.json({ files:result.rows.map(publicDocument) })
})

app.get('/api/v1/files/:documentId', async (request, response) => {
  const actor = actorContext(request)
  const result = await pool.query(`SELECT * FROM documents WHERE tenant_id=$1 AND document_id=$2 ORDER BY version::integer DESC`, [actor.tenantId, request.params.documentId])
  const readable = []
  for (const row of result.rows) if (await canReadDocument(actor, row.document_id, row.version)) readable.push(publicDocument(row))
  if (!readable.length) return response.status(404).json({ error:'document_not_found' })
  response.json({ documentId:request.params.documentId, versions:readable })
})

app.post('/api/v1/files', upload.single('file'), (request, response) => uploadDocument(request, response))
app.post('/api/v1/files/:documentId/versions', upload.single('file'), (request, response) => uploadDocument(request, response, request.params.documentId))

app.post('/api/v1/files/:documentId/versions/:version/reindex', async (request, response) => {
  const actor = actorContext(request)
  requireKnowledgeManager(actor,request)
  if (!(await canManageDocument(actor, request.params.documentId))) return response.status(403).json({ error:'forbidden' })
  const found = await pool.query(`SELECT 1 FROM documents WHERE tenant_id=$1 AND document_id=$2 AND version=$3 AND status <> 'DELETED'`, [actor.tenantId, request.params.documentId, request.params.version])
  if (!found.rowCount) return response.status(404).json({ error:'document_not_found' })
  const job = await enqueueJob({ tenantId:actor.tenantId, documentId:request.params.documentId, version:request.params.version, operation:'INDEX', createdBy:actor.userId })
  await audit({ actor, action:'DOCUMENT_REINDEX', resourceType:'DOCUMENT', resourceId:request.params.documentId, requestId:requestId(request), details:{ version:request.params.version, jobId:job.job_id } })
  response.status(202).json(publicJob(job))
})

app.delete('/api/v1/files/:documentId/versions/:version', async (request, response) => {
  const actor = actorContext(request)
  requireKnowledgeManager(actor,request)
  if (!(await canManageDocument(actor, request.params.documentId))) return response.status(403).json({ error:'forbidden' })
  const found = await pool.query(`SELECT 1 FROM documents WHERE tenant_id=$1 AND document_id=$2 AND version=$3 AND status <> 'DELETED'`, [actor.tenantId, request.params.documentId, request.params.version])
  if (!found.rowCount) return response.status(404).json({ error:'document_not_found' })
  const job = await enqueueJob({ tenantId:actor.tenantId, documentId:request.params.documentId, version:request.params.version, operation:'DELETE', createdBy:actor.userId })
  await audit({ actor, action:'DOCUMENT_DELETE', resourceType:'DOCUMENT', resourceId:request.params.documentId, requestId:requestId(request), details:{ version:request.params.version, jobId:job.job_id } })
  response.status(202).json(publicJob(job))
})

app.get('/api/v1/index-jobs/:jobId', async (request, response) => {
  const actor = actorContext(request)
  const result = await pool.query(`SELECT * FROM document_index_jobs WHERE tenant_id=$1 AND job_id=$2`, [actor.tenantId, request.params.jobId])
  if (!result.rowCount) return response.status(404).json({ error:'job_not_found' })
  response.json(publicJob(result.rows[0]))
})

app.get('/api/v1/knowledge-contexts', async (request, response) => {
  const actor = actorContext(request)
  const result = await pool.query(
    `SELECT c.context_id, c.name, c.status, c.created_at, c.expires_at,
       COALESCE(json_agg(json_build_object('documentId',a.document_id,'version',a.document_version)) FILTER (WHERE a.document_id IS NOT NULL),'[]') AS attachments
     FROM knowledge_contexts c LEFT JOIN knowledge_context_attachments a ON a.tenant_id=c.tenant_id AND a.context_id=c.context_id
     WHERE c.tenant_id=$1 AND c.user_id=$2 AND c.status='ACTIVE' GROUP BY c.context_id,c.name,c.status,c.created_at,c.expires_at ORDER BY c.created_at DESC`,
    [actor.tenantId, actor.userId],
  )
  response.json({ contexts:result.rows.map(row => ({ contextId:row.context_id, name:row.name, status:row.status, createdAt:row.created_at, expiresAt:row.expires_at, attachments:row.attachments })) })
})

app.post('/api/v1/knowledge-contexts', async (request, response) => {
  const actor = actorContext(request), attachments = Array.isArray(request.body.attachments) ? request.body.attachments.slice(0, 50) : []
  if (!attachments.length) return response.status(400).json({ error:'attachments_required' })
  for (const item of attachments) {
    if (!(await canReadDocument(actor, String(item.documentId), String(item.version)))) return response.status(403).json({ error:'attachment_forbidden', documentId:item.documentId })
  }
  const contextId = `ctx_${randomUUID()}`, name = String(request.body.name || 'DSH 文件上下文').trim().slice(0, 120)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO knowledge_contexts (tenant_id,context_id,user_id,name) VALUES ($1,$2,$3,$4)`, [actor.tenantId,contextId,actor.userId,name])
    for (const item of attachments) await client.query(
      `INSERT INTO knowledge_context_attachments (tenant_id,context_id,document_id,document_version,attached_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [actor.tenantId,contextId,String(item.documentId),String(item.version),actor.userId],
    )
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await audit({ actor, action:'KNOWLEDGE_CONTEXT_CREATE', resourceType:'KNOWLEDGE_CONTEXT', resourceId:contextId, requestId:requestId(request), details:{ attachmentCount:attachments.length } })
  response.status(201).json({ contextId, name, attachments })
})

app.delete('/api/v1/knowledge-contexts/:contextId', async (request, response) => {
  const actor = actorContext(request)
  const result = await pool.query(`UPDATE knowledge_contexts SET status='DELETED',updated_at=now() WHERE tenant_id=$1 AND context_id=$2 AND user_id=$3 AND status='ACTIVE'`, [actor.tenantId,request.params.contextId,actor.userId])
  if (!result.rowCount) return response.status(404).json({ error:'context_not_found' })
  await audit({ actor, action:'KNOWLEDGE_CONTEXT_DELETE', resourceType:'KNOWLEDGE_CONTEXT', resourceId:request.params.contextId, requestId:requestId(request) })
  response.status(204).end()
})

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error:error.code, message:error.message })
  if (error instanceof ActiveDocumentJobError) return response.status(409).json({
    error:'document_job_conflict',
    message:error.message,
    activeJob:publicJob(error.activeJob),
  })
  if (error.statusCode) return response.status(error.statusCode).json({ error:error.statusCode === 401 ? 'unauthorized' : 'request_failed',message:error.message })
  console.error(error)
  response.status(500).json({ error:'internal_error' })
})

await ensurePlatformSchema()
app.listen(port, '0.0.0.0', () => console.log(`bankops-file-service listening on 0.0.0.0:${port}`))
