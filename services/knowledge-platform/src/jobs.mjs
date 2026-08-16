import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { pool } from './db.mjs'

export class ActiveDocumentJobError extends Error {
  constructor(activeJob) {
    super(`document already has an active ${activeJob.operation} job`)
    this.name = 'ActiveDocumentJobError'
    this.activeJob = activeJob
  }
}

export async function enqueueJob({ tenantId, documentId, version, operation, createdBy }) {
  const jobId = randomUUID()
  const status = operation === 'DELETE' ? 'DELETE_QUEUED' : 'QUEUED'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize job submission for one document version across API replicas. The
    // unique index remains the final guard if callers race before acquiring this lock.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${tenantId}:${documentId}:${version}`])
    const active = await client.query(
      `SELECT * FROM document_index_jobs WHERE tenant_id=$1 AND document_id=$2 AND document_version=$3
       AND status IN ('QUEUED','RUNNING','RETRY') ORDER BY created_at DESC LIMIT 1`,
      [tenantId, documentId, version],
    )
    if (active.rows[0]) {
      await client.query('ROLLBACK')
      if (active.rows[0].operation !== operation) throw new ActiveDocumentJobError(active.rows[0])
      return active.rows[0]
    }
    await client.query(
      `UPDATE documents SET status=$1, index_error=NULL
       WHERE tenant_id=$2 AND document_id=$3 AND version=$4`,
      [status, tenantId, documentId, version],
    )
    const inserted = await client.query(
      `INSERT INTO document_index_jobs
       (job_id, tenant_id, document_id, document_version, operation, status, max_attempts, created_by)
       VALUES ($1,$2,$3,$4,$5,'QUEUED',$6,$7) RETURNING *`,
      [jobId, tenantId, documentId, version, operation, config.workerMaxAttempts, createdBy],
    )
    await client.query('COMMIT')
    return inserted.rows[0]
  } catch (error) {
    if (!['ActiveDocumentJobError'].includes(error.name)) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

export async function recoverStaleJobs() {
  await pool.query(
    `UPDATE document_index_jobs
     SET status='RETRY', available_at=now(), locked_by=NULL, locked_at=NULL,
         last_error=COALESCE(last_error || E'\n','') || 'worker lease expired', updated_at=now()
     WHERE status='RUNNING' AND locked_at < now() - ($1::text || ' milliseconds')::interval`,
    [config.workerStaleMs],
  )
}

export async function claimJob(workerId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query(
      `WITH candidate AS (
         SELECT job_id FROM document_index_jobs
         WHERE status IN ('QUEUED','RETRY') AND available_at <= now() AND attempts < max_attempts
         ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE document_index_jobs j
       SET status='RUNNING', attempts=j.attempts+1, locked_by=$1, locked_at=now(),
           started_at=COALESCE(j.started_at,now()), updated_at=now()
       FROM candidate WHERE j.job_id=candidate.job_id RETURNING j.*`,
      [workerId],
    )
    await client.query('COMMIT')
    return result.rows[0] ?? null
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export async function completeJob(jobId, result) {
  await pool.query(
    `UPDATE document_index_jobs SET status='COMPLETED', result=$2, completed_at=now(),
       locked_by=NULL, locked_at=NULL, updated_at=now() WHERE job_id=$1`,
    [jobId, result],
  )
}

export async function failJob(job, error) {
  const message = String(error?.message ?? error).slice(0, 4000)
  const final = job.attempts >= job.max_attempts
  const retrySeconds = Math.min(300, 5 * (2 ** Math.max(0, job.attempts - 1)))
  await pool.query(
    `UPDATE document_index_jobs SET status=$2, last_error=$3,
       available_at=CASE WHEN $2='RETRY' THEN now() + ($4::text || ' seconds')::interval ELSE available_at END,
       completed_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,
       locked_by=NULL, locked_at=NULL, updated_at=now() WHERE job_id=$1`,
    [job.job_id, final ? 'FAILED' : 'RETRY', message, retrySeconds],
  )
  await pool.query(
    `UPDATE documents SET status=$1, index_error=$2 WHERE tenant_id=$3 AND document_id=$4 AND version=$5`,
    [final ? 'FAILED' : (job.operation === 'DELETE' ? 'DELETE_QUEUED' : 'QUEUED'), message,
      job.tenant_id, job.document_id, job.document_version],
  )
}

export function publicJob(row) {
  return {
    jobId:row.job_id, documentId:row.document_id, version:row.document_version,
    operation:row.operation, status:row.status, attempts:row.attempts, maxAttempts:row.max_attempts,
    availableAt:row.available_at, startedAt:row.started_at, completedAt:row.completed_at,
    lastError:row.last_error, result:row.result, createdAt:row.created_at, updatedAt:row.updated_at,
  }
}
