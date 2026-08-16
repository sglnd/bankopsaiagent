import { createHmac, timingSafeEqual } from 'node:crypto'

export const config = {
  postgresUrl: process.env.DATABASE_URL ?? 'postgresql://bankops:bankops-local-change-me@postgres:5432/bankops',
  elasticsearchUrl: (process.env.ELASTICSEARCH_URL ?? 'http://elasticsearch:9200').replace(/\/$/, ''),
  minioEndpoint: process.env.MINIO_ENDPOINT ?? 'minio',
  minioPort: Number(process.env.MINIO_PORT ?? 9000),
  minioUseSsl: process.env.MINIO_USE_SSL === '1',
  minioAccessKey: process.env.MINIO_ACCESS_KEY ?? 'bankops-minio',
  minioSecretKey: process.env.MINIO_SECRET_KEY ?? 'bankops-minio-local-change-me',
  fileBucket: process.env.BANKOPS_FILE_BUCKET ?? 'bankops-files',
  knowledgeUrl: (process.env.BANKOPS_KNOWLEDGE_INTERNAL_URL ?? 'http://knowledge-mcp:8952').replace(/\/$/, ''),
  tenantId: process.env.BANKOPS_TENANT_ID ?? 'tenant-local',
  userId: process.env.BANKOPS_USER_ID ?? 'user-local',
  departmentId: process.env.BANKOPS_DEPARTMENT_ID ?? 'dept-operations',
  roles: (process.env.BANKOPS_ROLES ?? 'OPERATIONS').split(',').map(value => value.trim()).filter(Boolean),
  workspaceId: process.env.BANKOPS_WORKSPACE_ID ?? 'bankops-default',
  maxUploadBytes: Number(process.env.BANKOPS_MAX_UPLOAD_BYTES ?? 20 * 1024 * 1024),
  maxDocumentPages: Number(process.env.BANKOPS_MAX_DOCUMENT_PAGES ?? 500),
  maxExtractedChars: Number(process.env.BANKOPS_MAX_EXTRACTED_CHARS ?? 5_000_000),
  workerPollMs: Number(process.env.BANKOPS_WORKER_POLL_MS ?? 1_000),
  workerStaleMs: Number(process.env.BANKOPS_WORKER_STALE_MS ?? 10 * 60_000),
  workerMaxAttempts: Number(process.env.BANKOPS_WORKER_MAX_ATTEMPTS ?? 5),
  identitySigningSecret: process.env.BANKOPS_IDENTITY_SIGNING_SECRET ?? '',
  identityRequiredForRest: process.env.BANKOPS_IDENTITY_REQUIRED_FOR_REST === '1',
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a,b)
}

export function actorContext(request = null) {
  const payload = request?.headers?.['x-bankops-identity'], signature = request?.headers?.['x-bankops-identity-signature']
  if (payload || signature) {
    if (!payload || !signature || config.identitySigningSecret.length < 32) throw Object.assign(new Error('invalid identity context'),{ statusCode:401 })
    const expected = createHmac('sha256',config.identitySigningSecret).update(String(payload)).digest('base64url')
    if (!safeEqual(expected,signature)) throw Object.assign(new Error('invalid identity signature'),{ statusCode:401 })
    let identity
    try { identity=JSON.parse(Buffer.from(String(payload),'base64url').toString('utf8')) } catch { throw Object.assign(new Error('invalid identity payload'),{ statusCode:401 }) }
    if (!identity.userId || !identity.tenantId || !Array.isArray(identity.roles) || Math.abs(Date.now()-Number(identity.issuedAt))>60_000) {
      throw Object.assign(new Error('expired or incomplete identity context'),{ statusCode:401 })
    }
    return { tenantId:identity.tenantId,userId:identity.userId,departmentId:identity.departmentId,roles:identity.roles,workspaceId:identity.workspaceId }
  }
  if (request && config.identityRequiredForRest) throw Object.assign(new Error('signed identity required'),{ statusCode:401 })
  return {
    tenantId: config.tenantId,
    userId: config.userId,
    departmentId: config.departmentId,
    roles: config.roles,
    workspaceId: config.workspaceId,
  }
}
