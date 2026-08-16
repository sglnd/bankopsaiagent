CREATE TABLE IF NOT EXISTS departments (
  tenant_id text NOT NULL,
  department_id text NOT NULL,
  name text NOT NULL,
  parent_department_id text,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, department_id)
);

CREATE TABLE IF NOT EXISTS users (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  username text NOT NULL,
  display_name text NOT NULL,
  department_id text,
  status text NOT NULL DEFAULT 'ACTIVE',
  identity_provider text NOT NULL DEFAULT 'LOCAL_DEVELOPMENT',
  external_subject text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  UNIQUE (tenant_id, username),
  FOREIGN KEY (tenant_id, department_id)
    REFERENCES departments (tenant_id, department_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  role_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_name),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS documents (
  tenant_id text NOT NULL,
  document_id text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  filename text,
  status text NOT NULL DEFAULT 'DRAFT',
  classification text NOT NULL DEFAULT 'INTERNAL',
  owner_department_id text NOT NULL,
  minio_bucket text NOT NULL,
  minio_object_key text NOT NULL,
  content_sha256 text NOT NULL,
  media_type text,
  size_bytes bigint,
  created_by text NOT NULL,
  idempotency_key text,
  index_error text,
  indexed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  PRIMARY KEY (tenant_id, document_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS documents_upload_idempotency_idx
  ON documents (tenant_id, created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

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
    REFERENCES documents (tenant_id, document_id, version)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  tenant_id text NOT NULL,
  task_id text NOT NULL,
  task_type text NOT NULL,
  requested_by text NOT NULL,
  idempotency_key text,
  status text NOT NULL,
  runtime_version text,
  skill_name text,
  skill_revision integer,
  result_document_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  UNIQUE (tenant_id, task_type, idempotency_key)
);

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

CREATE INDEX IF NOT EXISTS audit_events_tenant_time_idx
  ON audit_events (tenant_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  department_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, department_id),
  UNIQUE (tenant_id, code)
);

ALTER TABLE departments ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
UPDATE departments SET code=upper(regexp_replace(department_id,'^dept-','')) WHERE code IS NULL;
ALTER TABLE departments ALTER COLUMN code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS departments_tenant_code_idx ON departments(tenant_id,code);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users(tenant_id,lower(username));

CREATE TABLE IF NOT EXISTS local_identity_credentials (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,user_id) ON DELETE CASCADE
);

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_by text;
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS auth_sessions (
  tenant_id text NOT NULL,
  session_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
  ON auth_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS identity_audit_events (
  event_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_user_id text,
  action text NOT NULL,
  target_user_id text,
  outcome text NOT NULL,
  ip_address text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE documents IS
  'Authoritative document metadata only; original bytes live in MinIO and searchable chunks live in Elasticsearch.';
COMMENT ON TABLE agent_tasks IS
  'Strongly consistent task state and idempotency boundary shared by every DSH runtime instance.';
