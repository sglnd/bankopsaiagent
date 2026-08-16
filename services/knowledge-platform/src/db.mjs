import pg from 'pg'
import { config } from './config.mjs'

export const pool = new pg.Pool({ connectionString: config.postgresUrl, max: 10 })

export async function ensurePlatformSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      tenant_id text NOT NULL,
      document_id text NOT NULL,
      version text NOT NULL,
      title text NOT NULL,
      status text NOT NULL DEFAULT 'DRAFT',
      classification text NOT NULL DEFAULT 'INTERNAL',
      owner_department_id text NOT NULL,
      minio_bucket text NOT NULL,
      minio_object_key text NOT NULL,
      content_sha256 text NOT NULL,
      media_type text,
      size_bytes bigint,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      valid_from timestamptz,
      valid_to timestamptz,
      PRIMARY KEY (tenant_id, document_id, version)
    );
    CREATE TABLE IF NOT EXISTS document_acl (
      tenant_id text NOT NULL,
      document_id text NOT NULL,
      document_version text NOT NULL,
      subject_type text NOT NULL CHECK (subject_type IN ('USER', 'DEPARTMENT', 'ROLE')),
      subject_id text NOT NULL,
      permission text NOT NULL CHECK (permission IN ('READ', 'MANAGE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, document_id, document_version, subject_type, subject_id, permission),
      FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES documents (tenant_id, document_id, version) ON DELETE CASCADE
    );
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS filename text;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS index_error text;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS indexed_at timestamptz;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS idempotency_key text;

    CREATE UNIQUE INDEX IF NOT EXISTS documents_upload_idempotency_idx
      ON documents (tenant_id, created_by, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS document_index_jobs (
      job_id uuid PRIMARY KEY,
      tenant_id text NOT NULL,
      document_id text NOT NULL,
      document_version text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('INDEX', 'DELETE')),
      status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'RETRY', 'COMPLETED', 'FAILED')),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 5,
      available_at timestamptz NOT NULL DEFAULT now(),
      locked_by text,
      locked_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      last_error text,
      result jsonb,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES documents (tenant_id, document_id, version)
    );
    CREATE INDEX IF NOT EXISTS document_index_jobs_poll_idx
      ON document_index_jobs (status, available_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS document_index_jobs_active_document_idx
      ON document_index_jobs (tenant_id, document_id, document_version)
      WHERE status IN ('QUEUED', 'RUNNING', 'RETRY');
    ALTER TABLE document_index_jobs ADD COLUMN IF NOT EXISTS result jsonb;

    CREATE TABLE IF NOT EXISTS knowledge_contexts (
      tenant_id text NOT NULL,
      context_id text NOT NULL,
      user_id text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz,
      PRIMARY KEY (tenant_id, context_id)
    );
    CREATE TABLE IF NOT EXISTS knowledge_context_attachments (
      tenant_id text NOT NULL,
      context_id text NOT NULL,
      document_id text NOT NULL,
      document_version text NOT NULL,
      attached_by text NOT NULL,
      attached_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, context_id, document_id, document_version),
      FOREIGN KEY (tenant_id, context_id)
        REFERENCES knowledge_contexts (tenant_id, context_id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, document_id, document_version)
        REFERENCES documents (tenant_id, document_id, version)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id uuid PRIMARY KEY,
      tenant_id text NOT NULL,
      actor_user_id text,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      request_id text,
      outcome text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `)
}

export async function getDocument(tenantId, documentId, version) {
  const result = await pool.query(
    `SELECT * FROM documents WHERE tenant_id = $1 AND document_id = $2 AND version = $3`,
    [tenantId, documentId, version],
  )
  return result.rows[0] ?? null
}

export async function getDocumentAcl(tenantId, documentId, version) {
  const result = await pool.query(
    `SELECT subject_type, subject_id, permission FROM document_acl
     WHERE tenant_id = $1 AND document_id = $2 AND document_version = $3`,
    [tenantId, documentId, version],
  )
  return result.rows
}

export async function canReadDocument(actor, documentId, version) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM documents d
       WHERE d.tenant_id=$1 AND d.document_id=$2 AND d.version=$3 AND d.status <> 'DELETED'
       AND (d.created_by=$4 OR EXISTS (
         SELECT 1 FROM document_acl a
         WHERE a.tenant_id=d.tenant_id AND a.document_id=d.document_id AND a.document_version=d.version
         AND ((a.subject_type='USER' AND a.subject_id=$4)
           OR (a.subject_type='DEPARTMENT' AND a.subject_id=$5)
           OR (a.subject_type='ROLE' AND a.subject_id = ANY($6::text[])))
       ))
     ) AS allowed`,
    [actor.tenantId, documentId, version, actor.userId, actor.departmentId, actor.roles],
  )
  return result.rows[0].allowed
}

export async function canManageDocument(actor, documentId) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM documents d WHERE d.tenant_id=$1 AND d.document_id=$2
       AND (d.created_by=$3 OR EXISTS (
         SELECT 1 FROM document_acl a WHERE a.tenant_id=d.tenant_id AND a.document_id=d.document_id
         AND a.permission='MANAGE' AND ((a.subject_type='USER' AND a.subject_id=$3)
           OR (a.subject_type='ROLE' AND a.subject_id = ANY($4::text[])))
       ))
     ) AS allowed`,
    [actor.tenantId, documentId, actor.userId, actor.roles],
  )
  return result.rows[0].allowed
}
