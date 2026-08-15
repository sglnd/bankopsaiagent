import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { runHeadlessAnalysis, validateCreateInput } from './analysis.mjs'
import { TaskStore } from './store.mjs'

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

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function publicTask(task) {
  const result = {
    analysisId: task.id,
    changeId: task.changeId,
    changeType: task.changeType,
    requestedBy: task.requestedBy,
    status: task.status,
    stage: task.stage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (task.startedAt) result.startedAt = task.startedAt
  if (task.completedAt) result.completedAt = task.completedAt
  if (task.result) result.result = task.result
  if (task.error) result.error = task.error
  return result
}

export async function createAgentApi(options = {}) {
  const store = options.store ?? new TaskStore(options.storeDir ?? '/data/agent-api/tasks')
  const runner = options.runner ?? runHeadlessAnalysis
  const runnerOptions = options.runnerOptions ?? {}
  const concurrency = Math.max(1, Number(options.concurrency ?? 1))
  const token = options.token ?? ''
  const allowUnauthenticated = options.allowUnauthenticated === true
  if (!token && !allowUnauthenticated) throw new Error('BANKOPS_AGENT_API_TOKEN is required')

  await store.initialize()
  const tasks = new Map()
  const idempotency = new Map()
  const queue = []
  const active = new Map()

  for (const task of await store.list()) {
    if (task.status === 'running') {
      task.status = 'failed'
      task.stage = 'failed'
      task.updatedAt = new Date().toISOString()
      task.completedAt = task.updatedAt
      task.error = { code: 'WORKER_RESTARTED', message: 'worker restarted while the task was running' }
      await store.save(task)
    }
    tasks.set(task.id, task)
    if (task.idempotencyKey) idempotency.set(task.idempotencyKey, task.id)
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
      if (!authorized(request)) return sendJson(response, 401, { error: 'unauthorized', requestId })

      if (request.method === 'POST' && url.pathname === '/api/v1/change-impact-analyses') {
        const input = validateCreateInput(await readJson(request))
        const idempotencyKey = request.headers['idempotency-key']?.toString().trim()
        if (idempotencyKey && (idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey))) {
          return sendJson(response, 400, { error: 'invalid_idempotency_key', requestId })
        }
        if (idempotencyKey && idempotency.has(idempotencyKey)) {
          const existing = tasks.get(idempotency.get(idempotencyKey))
          return sendJson(response, existing.status === 'completed' ? 200 : 202, publicTask(existing), {
            'idempotency-replayed': 'true',
          })
        }

        const now = new Date().toISOString()
        const task = {
          id: `cia_${randomUUID()}`,
          ...input,
          idempotencyKey: idempotencyKey || undefined,
          status: 'queued',
          stage: 'queued',
          createdAt: now,
          updatedAt: now,
        }
        tasks.set(task.id, task)
        if (idempotencyKey) idempotency.set(idempotencyKey, task.id)
        queue.push(task.id)
        await store.save(task)
        void pump()
        return sendJson(response, 202, publicTask(task), {
          location: `/api/v1/change-impact-analyses/${task.id}`,
        })
      }

      const match = /^\/api\/v1\/change-impact-analyses\/(cia_[0-9a-f-]{36})(\/cancel)?$/.exec(url.pathname)
      if (match && request.method === 'GET' && !match[2]) {
        const task = tasks.get(match[1])
        return task
          ? sendJson(response, 200, publicTask(task))
          : sendJson(response, 404, { error: 'analysis_not_found', requestId })
      }
      if (match && request.method === 'POST' && match[2] === '/cancel') {
        const task = tasks.get(match[1])
        if (!task) return sendJson(response, 404, { error: 'analysis_not_found', requestId })
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

      sendJson(response, 404, { error: 'not_found', requestId })
    } catch (error) {
      const status = error?.statusCode ?? (error instanceof TypeError ? 400 : 500)
      sendJson(response, status, {
        error: status === 500 ? 'internal_error' : 'invalid_request',
        message: status === 500 ? undefined : error.message,
        requestId,
      })
    }
  })

  void pump()
  return { server, store, tasks }
}

async function main() {
  const mode = process.env.BANKOPS_AGENT_RUNNER_MODE ?? 'real'
  const api = await createAgentApi({
    storeDir: process.env.BANKOPS_AGENT_TASK_DIR ?? '/data/agent-api/tasks',
    token: process.env.BANKOPS_AGENT_API_TOKEN ?? '',
    allowUnauthenticated: process.env.BANKOPS_AGENT_API_ALLOW_UNAUTHENTICATED === '1',
    concurrency: process.env.BANKOPS_AGENT_MAX_CONCURRENCY ?? 1,
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
