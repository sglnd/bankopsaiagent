import pg from 'pg'
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { hashPassword, normalizeUsername } from './security.mjs'

export const pool = new pg.Pool({ connectionString:config.databaseUrl, max:10, idleTimeoutMillis:30000 })

export const DEPARTMENTS = [
  ['GENERAL','综合团队',10], ['TECHNOLOGY','技术团队',20], ['SECURITY','安全团队',30],
  ['CLOUD','云团队',40], ['SYSTEM','系统团队',50], ['NETWORK','网络团队',60], ['ENVIRONMENT','环境团队',70],
]
export const ROLES = ['PLATFORM_ADMIN','DEPARTMENT_ADMIN','OPERATOR','SECURITY_AUDITOR','KNOWLEDGE_MANAGER','SKILL_DEVELOPER']

export async function ensureIdentitySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id text PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS departments (
      tenant_id text NOT NULL REFERENCES tenants(tenant_id), department_id text NOT NULL,
      code text NOT NULL, name text NOT NULL, sort_order integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, department_id),
      UNIQUE (tenant_id, code)
    );
    ALTER TABLE departments ADD COLUMN IF NOT EXISTS code text;
    ALTER TABLE departments ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
    UPDATE departments SET code=upper(regexp_replace(department_id,'^dept-','')) WHERE code IS NULL;
    ALTER TABLE departments ALTER COLUMN code SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS departments_tenant_code_idx ON departments(tenant_id,code);
    CREATE TABLE IF NOT EXISTS users (
      tenant_id text NOT NULL, user_id text NOT NULL, username text NOT NULL, display_name text NOT NULL,
      department_id text, status text NOT NULL DEFAULT 'PENDING', identity_provider text NOT NULL DEFAULT 'LOCAL',
      external_subject text, created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(tenant_id,user_id),UNIQUE(tenant_id,username),
      FOREIGN KEY(tenant_id,department_id) REFERENCES departments(tenant_id,department_id)
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz;
    ALTER TABLE users ALTER COLUMN status SET DEFAULT 'PENDING';
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users(tenant_id,lower(username));
    CREATE TABLE IF NOT EXISTS local_identity_credentials (
      tenant_id text NOT NULL,user_id text NOT NULL,password_hash text NOT NULL,password_salt text NOT NULL,
      password_changed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,user_id),
      FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_roles (
      tenant_id text NOT NULL, user_id text NOT NULL, role_name text NOT NULL,
      granted_by text, granted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id, role_name),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, user_id) ON DELETE CASCADE
    );
    ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_by text;
    ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS granted_at timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS auth_sessions (
      tenant_id text NOT NULL, session_id uuid PRIMARY KEY, user_id text NOT NULL,
      token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL, expires_at timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
      ip_address text, user_agent text, created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS identity_audit_events (
      event_id uuid PRIMARY KEY, tenant_id text NOT NULL, actor_user_id text, action text NOT NULL,
      target_user_id text, outcome text NOT NULL, ip_address text, details jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `)
  const legacy = await pool.query(`SELECT to_regclass('public.platform_users') IS NOT NULL AS available`)
  if (legacy.rows[0].available) {
    await pool.query(`
      INSERT INTO users(tenant_id,user_id,username,display_name,email,department_id,status,identity_provider,
        failed_login_attempts,locked_until,last_login_at,approved_by,approved_at,created_at,updated_at)
      SELECT tenant_id,user_id,username,display_name,email,department_id,status,'LOCAL',failed_login_attempts,
        locked_until,last_login_at,approved_by,approved_at,created_at,updated_at FROM platform_users
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,
        email=EXCLUDED.email,department_id=EXCLUDED.department_id,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at;
      INSERT INTO local_identity_credentials(tenant_id,user_id,password_hash,password_salt)
      SELECT tenant_id,user_id,password_hash,password_salt FROM platform_users ON CONFLICT(tenant_id,user_id) DO NOTHING;
      INSERT INTO user_roles(tenant_id,user_id,role_name,granted_by,granted_at)
      SELECT tenant_id,user_id,role_code,granted_by,granted_at FROM platform_user_roles ON CONFLICT DO NOTHING;
    `)
  }
  await pool.query(`ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_tenant_id_user_id_fkey;
    ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_tenant_id_user_id_fkey
      FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,user_id) ON DELETE CASCADE;
    ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_tenant_id_user_id_fkey;
    ALTER TABLE user_roles ADD CONSTRAINT user_roles_tenant_id_user_id_fkey
      FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,user_id) ON DELETE CASCADE;`)
  await pool.query(`INSERT INTO tenants(tenant_id,name) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()`, [config.tenantId,config.tenantName])
  for (const [code,name,sortOrder] of DEPARTMENTS) {
    await pool.query(`INSERT INTO departments(tenant_id,department_id,code,name,sort_order) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(tenant_id,department_id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,sort_order=EXCLUDED.sort_order,updated_at=now()`,
    [config.tenantId,`dept-${code.toLowerCase()}`,code,name,sortOrder])
  }
  if (config.bootstrapUsername && config.bootstrapPassword) await ensureBootstrapAdmin()
}

async function ensureBootstrapAdmin() {
  const username = normalizeUsername(config.bootstrapUsername)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${config.tenantId}:bootstrap-admin`])
    const existing = await client.query(`SELECT user_id FROM users WHERE tenant_id=$1 AND lower(username)=$2`, [config.tenantId,username])
    if (existing.rowCount) { await client.query('COMMIT');return }
    const credentials = await hashPassword(config.bootstrapPassword), userId = `usr_${randomUUID()}`
    await client.query(`INSERT INTO users(tenant_id,user_id,username,display_name,department_id,status,identity_provider,approved_by,approved_at)
      VALUES($1,$2,$3,$4,'dept-general','ACTIVE','LOCAL',$2,now())`,
    [config.tenantId,userId,username,config.bootstrapDisplayName])
    await client.query(`INSERT INTO local_identity_credentials(tenant_id,user_id,password_hash,password_salt) VALUES($1,$2,$3,$4)`,[config.tenantId,userId,credentials.hash,credentials.salt])
    for (const role of ROLES) await client.query(`INSERT INTO user_roles(tenant_id,user_id,role_name,granted_by) VALUES($1,$2,$3,$2)`, [config.tenantId,userId,role])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function auditIdentity({ actorUserId = null, action, targetUserId = null, outcome = 'SUCCESS', ipAddress = null, details = {} }) {
  await pool.query(`INSERT INTO identity_audit_events(event_id,tenant_id,actor_user_id,action,target_user_id,outcome,ip_address,details)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(),config.tenantId,actorUserId,action,targetUserId,outcome,ipAddress,details])
}
