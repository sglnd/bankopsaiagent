import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { runHeadlessAnalysis, validateCreateInput } from './analysis.mjs'
import { runSystemInspection, validateInspectionInput } from './inspection.mjs'
import { McpCatalog, catalogServersFromEnv } from './mcp-catalog.mjs'
import { SkillStore, validateSkillSnapshot } from './skill-store.mjs'
import { TaskStore } from './store.mjs'
import { requireIdentityRole, verifyIdentity } from './identity.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function sendJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders })
  response.end(`${JSON.stringify(value)}\n`)
}

async function readJson(request, limit = 16 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 })
  }
}

async function readOptionalJson(request, limit = 512 * 1024) {
  if (request.headers['content-length'] === '0') return {}
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('request body is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 })
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function publicTask(task) {
  const isInspection = task.kind === 'system-inspection' || task.id.startsWith('sia_')
  const result = {
    [isInspection ? 'inspectionId' : 'analysisId']: task.id,
    requestedBy: task.requestedBy,
    status: task.status,
    stage: task.stage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (isInspection) {
    result.serviceId = task.serviceId
    result.environment = task.environment
    result.alertLookbackHours = task.alertLookbackHours
    result.metricLookbackHours = task.metricLookbackHours
  } else {
    result.changeId = task.changeId
    result.changeType = task.changeType
  }
  if (task.startedAt) result.startedAt = task.startedAt
  if (task.completedAt) result.completedAt = task.completedAt
  if (task.result) result.result = task.result
  if (task.error) result.error = task.error
  return result
}

export async function createAgentApi(options = {}) {
  const store = options.store ?? new TaskStore(options.storeDir ?? '/data/agent-api/tasks')
  const skillStore = options.skillStore ?? new SkillStore(
    options.skillDir ?? (options.storeDir ? `${options.storeDir}/skills` : '/data/dsh/bankops-skills'),
  )
  const catalog = options.catalog ?? new McpCatalog({
    servers: options.mcpServers ?? catalogServersFromEnv(),
    ttlMs: options.catalogTtlMs,
    timeoutMs: options.catalogTimeoutMs,
  })
  const runner = options.runner ?? ((task, runnerOptions) => (
    task.kind === 'system-inspection' || task.id.startsWith('sia_')
      ? runSystemInspection(task, runnerOptions)
      : runHeadlessAnalysis(task, runnerOptions)
  ))
  const runnerOptions = options.runnerOptions ?? {}
  const concurrency = Math.max(1, Number(options.concurrency ?? 1))
  const token = options.token ?? ''
  const identitySigningSecret = options.identitySigningSecret ?? ''
  const allowUnauthenticated = options.allowUnauthenticated === true
  if (!token && !allowUnauthenticated) throw new Error('BANKOPS_AGENT_API_TOKEN is required')

  await store.initialize()
  await skillStore.initialize()
  const tasks = new Map()
  const idempotency = new Map()
  const queue = []
  const active = new Map()

  for (const task of await store.list()) {
    task.kind ??= task.id.startsWith('sia_') ? 'system-inspection' : 'change-impact'
    if (task.status === 'running') {
      task.status = 'failed'
      task.stage = 'failed'
      task.updatedAt = new Date().toISOString()
      task.completedAt = task.updatedAt
      task.error = { code: 'WORKER_RESTARTED', message: 'worker restarted while the task was running' }
      await store.save(task)
    }
    tasks.set(task.id, task)
    if (task.idempotencyKey) idempotency.set(`${task.kind}:${task.idempotencyKey}`, task.id)
    if (task.status === 'queued') queue.push(task.id)
  }

  let pumping = false
  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (active.size < concurrency && queue.length > 0) {
        const id = queue.shift()
        const task = tasks.get(id)
        if (!task || task.status !== 'queued') continue
        const controller = new AbortController()
        active.set(id, controller)
        void execute(task, controller).finally(() => {
          active.delete(id)
          void pump()
        })
      }
    } finally {
      pumping = false
    }
  }

  async function execute(task, controller) {
    task.status = 'running'
    task.stage = 'analyzing'
    task.startedAt = new Date().toISOString()
    task.updatedAt = task.startedAt
    await store.save(task)
    try {
      const result = await runner(task, {
        ...runnerOptions,
        signal: controller.signal,
        onSpawn(child) {
          const abort = () => child.kill('SIGTERM')
          if (controller.signal.aborted) abort()
          else controller.signal.addEventListener('abort', abort, { once: true })
          runnerOptions.onSpawn?.(child)
        },
      })
      if (controller.signal.aborted) throw Object.assign(new Error('analysis was cancelled'), { cancelled: true })
      task.status = 'completed'
      task.stage = 'completed'
      task.result = result
    } catch (error) {
      task.status = error?.cancelled || controller.signal.aborted ? 'cancelled' : 'failed'
      task.stage = task.status
      task.error = {
        code: task.status === 'cancelled' ? 'CANCELLED' : 'ANALYSIS_FAILED',
        message: String(error?.message ?? error).slice(0, 4096),
      }
    }
    task.updatedAt = new Date().toISOString()
    task.completedAt = task.updatedAt
    await store.save(task)
  }

  function authorized(request) {
    if (!token) return allowUnauthenticated
    const header = request.headers.authorization ?? ''
    return header.startsWith('Bearer ') && safeEqual(header.slice(7), token)
  }

  const server = createServer(async (request, response) => {
    const requestId = request.headers['x-request-id']?.toString() ?? randomUUID()
    response.setHeader('x-request-id', requestId)
    try {
      const url = new URL(request.url, 'http://agent-api.local')
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', queued: queue.length, running: active.size })
      }
      if (request.method === 'GET' && ['/skill-studio', '/skill-studio/'].includes(url.pathname)) {
        response.writeHead(308, {
          location: process.env.BANKOPS_PORTAL_URL ?? 'http://127.0.0.1:8080/skill-studio',
          'cache-control': 'no-store',
        })
        return response.end()
      }
      if (!authorized(request)) return sendJson(response, 401, { error: 'unauthorized', requestId })
      const identity = verifyIdentity(request,identitySigningSecret)

      if (request.method === 'GET' && url.pathname === '/api/v1/mcp-catalog') {
        const value = await catalog.get({ refresh: url.searchParams.get('refresh') === '1' })
        return sendJson(response, 200, value)
      }

      if (url.pathname === '/api/v1/skills' && request.method === 'GET') {
        return sendJson(response, 200, { skills: await skillStore.list() })
      }
      if (url.pathname === '/api/v1/skills' && request.method === 'POST') {
        requireIdentityRole(identity,['PLATFORM_ADMIN','SKILL_DEVELOPER'])
        const catalogSnapshot = await catalog.get()
        const skill = await skillStore.create(await readOptionalJson(request), catalogSnapshot)
        return sendJson(response, 201, skill, {
          location: `/api/v1/skills/${skill.name}`,
          etag: `"revision-${skill.revision}"`,
        })
      }

      const skillMatch = /^\/api\/v1\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/(validate|publish|rollback|versions))?$/.exec(url.pathname)
      if (skillMatch) {
        const [, skillName, action] = skillMatch
        if (!action && request.method === 'GET') {
          const revisionValue = url.searchParams.get('revision')
          const revision = revisionValue === null ? undefined : Number(revisionValue)
          const skill = await skillStore.get(skillName, revision)
          return skill
            ? sendJson(response, 200, skill, { etag: `"revision-${skill.revision}"` })
            : sendJson(response, 404, { error: 'skill_not_found', requestId })
        }
        if (!action && request.method === 'PUT') {
          requireIdentityRole(identity,['PLATFORM_ADMIN','SKILL_DEVELOPER'])
          const catalogSnapshot = await catalog.get()
          const skill = await skillStore.update(skillName, await readOptionalJson(request), catalogSnapshot)
          return sendJson(response, 200, skill, { etag: `"revision-${skill.revision}"` })
        }
        if (action === 'versions' && request.method === 'GET') {
          const skill = await skillStore.get(skillName)
          return skill
            ? sendJson(response, 200, {
                name: skill.name, currentRevision: skill.currentRevision,
                publishedRevision: skill.publishedRevision, revisions: skill.revisions,
              })
            : sendJson(response, 404, { error: 'skill_not_found', requestId })
        }
        if (action === 'validate' && request.method === 'POST') {
          requireIdentityRole(identity,['PLATFORM_ADMIN','SKILL_DEVELOPER'])
          const input = await readOptionalJson(request)
          const skill = await skillStore.get(skillName, input.revision)
          if (!skill) return sendJson(response, 404, { error: 'skill_not_found', requestId })
          return sendJson(response, 200, {
            name: skill.name, revision: skill.revision,
            ...validateSkillSnapshot(skill, await catalog.get({ refresh: input.refreshCatalog === true })),
          })
        }
        if (action === 'publish' && request.method === 'POST') {
          requireIdentityRole(identity,['PLATFORM_ADMIN','SKILL_DEVELOPER'])
          const input = await readOptionalJson(request)
          const published = await skillStore.publish(skillName, input.revision, await catalog.get({ refresh: true }))
          return sendJson(response, 200, {
            name: skillName, publishedRevision: published.skill.revision,
            publishedAt: published.skill.publishedAt,
            validation: published.validation,
            runtime: {
              headless: 'available on the next DSH process',
              web: 'restart Harness and start a new session to refresh the skill list',
            },
          })
        }
        if (action === 'rollback' && request.method === 'POST') {
          requireIdentityRole(identity,['PLATFORM_ADMIN','SKILL_DEVELOPER'])
          const input = await readOptionalJson(request)
          if (!Number.isInteger(input.revision)) throw Object.assign(new Error('revision is required'), { statusCode: 400 })
          const published = await skillStore.rollback(skillName, input.revision, await catalog.get({ refresh: true }))
          return sendJson(response, 200, {
            name: skillName, publishedRevision: published.skill.revision,
            validation: published.validation,
          })
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/change-impact-analyses') {
        requireIdentityRole(identity,['PLATFORM_ADMIN','OPERATOR'])
        const rawInput = await readJson(request)
        const input = validateCreateInput({ ...rawInput,requestedBy:identity?.userId ?? rawInput.requestedBy })
        const idempotencyKey = request.headers['idempotency-key']?.toString().trim()
        const scopedIdempotencyKey = idempotencyKey ? `change-impact:${idempotencyKey}` : undefined
        if (idempotencyKey && (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))) {
          return sendJson(response, 400, { error: 'invalid_idempotency_key', requestId })
        }
        if (scopedIdempotencyKey && idempotency.has(scopedIdempotencyKey)) {
          const existing = tasks.get(idempotency.get(scopedIdempotencyKey))
          return sendJson(response, existing.status === 'completed' ? 200 : 202, publicTask(existing), {
            'idempotency-replayed': 'true',
          })
        }

        const now = new Date().toISOString()
        const task = {
          id: `cia_${randomUUID()}`,
          kind: 'change-impact',
          ...input,
          idempotencyKey: idempotencyKey || undefined,
          status: 'queued',
          stage: 'queued',
          createdAt: now,
          updatedAt: now,
        }
        tasks.set(task.id, task)
        if (scopedIdempotencyKey) idempotency.set(scopedIdempotencyKey, task.id)
        queue.push(task.id)
        await store.save(task)
        void pump()
        return sendJson(response, 202, publicTask(task), {
          location: `/api/v1/change-impact-analyses/${task.id}`,
        })
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/system-inspections') {
        requireIdentityRole(identity,['PLATFORM_ADMIN','OPERATOR'])
        const rawInput = await readJson(request)
        const input = validateInspectionInput({ ...rawInput,requestedBy:identity?.userId ?? rawInput.requestedBy })
        const idempotencyKey = request.headers['idempotency-key']?.toString().trim()
        const scopedIdempotencyKey = idempotencyKey ? `system-inspection:${idempotencyKey}` : undefined
        if (idempotencyKey && (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))) {
          return sendJson(response, 400, { error: 'invalid_idempotency_key', requestId })
        }
        if (scopedIdempotencyKey && idempotency.has(scopedIdempotencyKey)) {
          const existing = tasks.get(idempotency.get(scopedIdempotencyKey))
          return sendJson(response, existing.status === 'completed' ? 200 : 202, publicTask(existing), {
            'idempotency-replayed': 'true',
          })
        }

        const now = new Date().toISOString()
        const task = {
          id: `sia_${randomUUID()}`,
          kind: 'system-inspection',
          ...input,
          idempotencyKey: idempotencyKey || undefined,
          status: 'queued', stage: 'queued', createdAt: now, updatedAt: now,
        }
        tasks.set(task.id, task)
        if (scopedIdempotencyKey) idempotency.set(scopedIdempotencyKey, task.id)
        queue.push(task.id)
        await store.save(task)
        void pump()
        return sendJson(response, 202, publicTask(task), {
          location: `/api/v1/system-inspections/${task.id}`,
        })
      }

      const match = /^\/api\/v1\/change-impact-analyses\/(cia_[0-9a-f-]{36})(\/cancel)?$/.exec(url.pathname)
      if (match && request.method === 'GET' && !match[2]) {
        const task = tasks.get(match[1])
        if (task && identity && task.requestedBy !== identity.userId && !identity.roles.includes('PLATFORM_ADMIN')) return sendJson(response,403,{ error:'forbidden',requestId })
        return task
          ? sendJson(response, 200, publicTask(task))
          : sendJson(response, 404, { error: 'analysis_not_found', requestId })
      }
      if (match && request.method === 'POST' && match[2] === '/cancel') {
        const task = tasks.get(match[1])
        if (!task) return sendJson(response, 404, { error: 'analysis_not_found', requestId })
        if (identity && task.requestedBy !== identity.userId && !identity.roles.includes('PLATFORM_ADMIN')) return sendJson(response,403,{ error:'forbidden',requestId })
        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          return sendJson(response, 409, { error: 'analysis_not_cancellable', status: task.status, requestId })
        }
        if (task.status === 'queued') {
          task.status = 'cancelled'
          task.stage = 'cancelled'
          task.updatedAt = new Date().toISOString()
          task.completedAt = task.updatedAt
          task.error = { code: 'CANCELLED', message: 'analysis was cancelled before execution' }
          await store.save(task)
        } else {
          active.get(task.id)?.abort()
        }
        return sendJson(response, 202, publicTask(task))
      }

      const inspectionMatch = /^\/api\/v1\/system-inspections\/(sia_[0-9a-f-]{36})(\/cancel)?$/.exec(url.pathname)
      if (inspectionMatch && request.method === 'GET' && !inspectionMatch[2]) {
        const task = tasks.get(inspectionMatch[1])
        if (task && identity && task.requestedBy !== identity.userId && !identity.roles.includes('PLATFORM_ADMIN')) return sendJson(response,403,{ error:'forbidden',requestId })
        return task
          ? sendJson(response, 200, publicTask(task))
          : sendJson(response, 404, { error: 'inspection_not_found', requestId })
      }
      if (inspectionMatch && request.method === 'POST' && inspectionMatch[2] === '/cancel') {
        const task = tasks.get(inspectionMatch[1])
        if (!task) return sendJson(response, 404, { error: 'inspection_not_found', requestId })
        if (identity && task.requestedBy !== identity.userId && !identity.roles.includes('PLATFORM_ADMIN')) return sendJson(response,403,{ error:'forbidden',requestId })
        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          return sendJson(response, 409, { error: 'inspection_not_cancellable', status: task.status, requestId })
        }
        if (task.status === 'queued') {
          task.status = 'cancelled'
          task.stage = 'cancelled'
          task.updatedAt = new Date().toISOString()
          task.completedAt = task.updatedAt
          task.error = { code: 'CANCELLED', message: 'inspection was cancelled before execution' }
          await store.save(task)
        } else {
          active.get(task.id)?.abort()
        }
        return sendJson(response, 202, publicTask(task))
      }

      sendJson(response, 404, { error: 'not_found', requestId })
    } catch (error) {
      const status = error?.statusCode ?? (error instanceof TypeError ? 400 : 500)
      sendJson(response, status, {
        error: status === 500 ? 'internal_error' : 'invalid_request',
        message: status === 500 ? undefined : error.message,
        details: status === 500 ? undefined : error.details,
        requestId,
      })
    }
  })

  void pump()
  return { server, store, skillStore, catalog, tasks }
}

async function main() {
  const mode = process.env.BANKOPS_AGENT_RUNNER_MODE ?? 'real'
  const api = await createAgentApi({
    storeDir: process.env.BANKOPS_AGENT_TASK_DIR ?? '/data/agent-api/tasks',
    skillDir: process.env.BANKOPS_AGENT_SKILL_DIR ?? '/data/dsh/bankops-skills',
    token: process.env.BANKOPS_AGENT_API_TOKEN ?? '',
    allowUnauthenticated: process.env.BANKOPS_AGENT_API_ALLOW_UNAUTHENTICATED === '1',
    identitySigningSecret: process.env.BANKOPS_IDENTITY_SIGNING_SECRET ?? '',
    concurrency: process.env.BANKOPS_AGENT_MAX_CONCURRENCY ?? 1,
    catalogTtlMs: Number(process.env.BANKOPS_MCP_CATALOG_TTL_MS ?? 60_000),
    catalogTimeoutMs: Number(process.env.BANKOPS_MCP_CATALOG_TIMEOUT_MS ?? 5_000),
    runnerOptions: {
      mode,
      cwd: process.env.BANKOPS_AGENT_WORKSPACE ?? '/workspace',
      timeoutMs: Number(process.env.BANKOPS_AGENT_TIMEOUT_MS ?? 300_000),
      mockDelayMs: Number(process.env.BANKOPS_AGENT_MOCK_DELAY_MS ?? 25),
    },
  })
  const host = process.env.BANKOPS_AGENT_API_HOST ?? '0.0.0.0'
  const port = Number(process.env.BANKOPS_AGENT_API_PORT ?? 8090)
  api.server.listen(port, host, () => {
    console.log(`[bankops-agent-api] ${host}:${port} runner=${mode}`)
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
