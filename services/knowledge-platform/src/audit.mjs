import { randomUUID } from 'node:crypto'
import { pool } from './db.mjs'

export async function audit({ actor, action, resourceType, resourceId, outcome = 'SUCCESS', requestId, details = {} }) {
  try {
    await pool.query(
      `INSERT INTO audit_events (event_id, tenant_id, actor_user_id, action, resource_type, resource_id, request_id, outcome, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), actor.tenantId, actor.userId, action, resourceType, resourceId, requestId, outcome, details],
    )
  } catch (error) {
    console.error('[audit] failed to persist audit event', error)
  }
}
