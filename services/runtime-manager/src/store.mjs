import pg from 'pg'

export class RuntimeStore {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, max:10, idleTimeoutMillis:30000 })
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_runtimes (
        runtime_id uuid PRIMARY KEY,
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        provider text NOT NULL,
        provider_runtime_id text,
        status text NOT NULL,
        desired_status text NOT NULL,
        image text NOT NULL,
        dsh_version text NOT NULL,
        dsh_home_volume text NOT NULL,
        workspace_volume text NOT NULL,
        endpoint jsonb,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        stopped_at timestamptz,
        deleted_at timestamptz
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_runtimes_one_live_per_user
        ON agent_runtimes(tenant_id,user_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS agent_runtimes_status_idx ON agent_runtimes(status,updated_at);
      CREATE TABLE IF NOT EXISTS agent_runtime_events (
        event_id uuid PRIMARY KEY,
        runtime_id uuid NOT NULL REFERENCES agent_runtimes(runtime_id),
        tenant_id text NOT NULL,
        user_id text NOT NULL,
        action text NOT NULL,
        outcome text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT now()
      );
    `)
  }

  async health() { await this.pool.query('SELECT 1') }

  async createOrGet(runtime) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${runtime.tenantId}:${runtime.userId}:runtime`])
      const existing = await client.query('SELECT * FROM agent_runtimes WHERE tenant_id=$1 AND user_id=$2 AND deleted_at IS NULL', [runtime.tenantId,runtime.userId])
      if (existing.rowCount) { await client.query('COMMIT'); return { runtime:this.public(existing.rows[0]), created:false } }
      const inserted = await client.query(`INSERT INTO agent_runtimes
        (runtime_id,tenant_id,user_id,provider,status,desired_status,image,dsh_version,dsh_home_volume,workspace_volume)
        VALUES($1,$2,$3,$4,'PROVISIONING',$5,$6,$7,$8,$9) RETURNING *`,
      [runtime.runtimeId,runtime.tenantId,runtime.userId,runtime.provider,runtime.desiredStatus,runtime.image,runtime.dshVersion,runtime.dshHomeVolume,runtime.workspaceVolume])
      await client.query('COMMIT')
      return { runtime:this.public(inserted.rows[0]), created:true }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async get(runtimeId) {
    const result = await this.pool.query('SELECT * FROM agent_runtimes WHERE runtime_id=$1', [runtimeId])
    return result.rows[0] ? this.public(result.rows[0]) : undefined
  }

  async update(runtimeId, patch) {
    const fields = [], values = []
    const mapping = { providerRuntimeId:'provider_runtime_id',status:'status',desiredStatus:'desired_status',endpoint:'endpoint',lastError:'last_error' }
    for (const [key,column] of Object.entries(mapping)) if (Object.hasOwn(patch,key)) { values.push(patch[key]);fields.push(`${column}=$${values.length}`) }
    if (patch.started) fields.push('started_at=now()')
    if (patch.stopped) fields.push('stopped_at=now()')
    if (patch.deleted) fields.push('deleted_at=now()')
    fields.push('updated_at=now()'); values.push(runtimeId)
    const result = await this.pool.query(`UPDATE agent_runtimes SET ${fields.join(',')} WHERE runtime_id=$${values.length} RETURNING *`, values)
    return result.rows[0] ? this.public(result.rows[0]) : undefined
  }

  async event(event) {
    await this.pool.query(`INSERT INTO agent_runtime_events(event_id,runtime_id,tenant_id,user_id,action,outcome,details)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [event.eventId,event.runtimeId,event.tenantId,event.userId,event.action,event.outcome,event.details ?? {}])
  }

  public(row) {
    return {
      runtimeId:row.runtime_id, tenantId:row.tenant_id, userId:row.user_id, provider:row.provider,
      providerRuntimeId:row.provider_runtime_id, status:row.status, desiredStatus:row.desired_status,
      image:row.image, dshVersion:row.dsh_version, dshHomeVolume:row.dsh_home_volume,
      workspaceVolume:row.workspace_volume, endpoint:row.endpoint, lastError:row.last_error,
      createdAt:row.created_at, updatedAt:row.updated_at, startedAt:row.started_at,
      stoppedAt:row.stopped_at, deletedAt:row.deleted_at,
    }
  }
}
