import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { runHeadlessAnalysis } from '../analysis.mjs'
import { createAgentApi } from '../server.mjs'

const servers = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

async function start(options = {}) {
  const storeDir = await mkdtemp(join(tmpdir(), 'bankops-agent-api-'))
  const api = await createAgentApi({
    storeDir,
    token: 'test-token',
    runner: runHeadlessAnalysis,
    runnerOptions: { mode: 'mock', mockDelayMs: options.mockDelayMs ?? 10 },
    concurrency: 1,
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  servers.push(api.server)
  return `http://127.0.0.1:${api.server.address().port}`
}

async function create(base, headers = {}) {
  return fetch(`${base}/api/v1/change-impact-analyses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      changeId: 'CHG-APP-0001',
      changeType: 'APPLICATION_RELEASE',
      requestedBy: 'test-suite',
    }),
  })
}

test('requires authentication and reports health without it', async () => {
  const base = await start()
  assert.equal((await fetch(`${base}/health`)).status, 200)
  const unauthorized = await fetch(`${base}/api/v1/change-impact-analyses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ changeId: 'CHG-APP-0001' }),
  })
  assert.equal(unauthorized.status, 401)
})

test('creates, persists, and completes an asynchronous analysis', async () => {
  const base = await start()
  const created = await create(base, { 'idempotency-key': 'test-change-v1' })
  assert.equal(created.status, 202)
  assert.match(created.headers.get('location'), /^\/api\/v1\/change-impact-analyses\/cia_/)
  const initial = await created.json()

  let current
  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(`${base}/api/v1/change-impact-analyses/${initial.analysisId}`, {
      headers: { authorization: 'Bearer test-token' },
    })
    current = await response.json()
    if (current.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(current.status, 'completed')
  assert.equal(current.result.changeId, 'CHG-APP-0001')
  assert.equal(current.result.riskLevel, 'UNDETERMINED')

  const replay = await create(base, { 'idempotency-key': 'test-change-v1' })
  assert.equal(replay.status, 200)
  assert.equal(replay.headers.get('idempotency-replayed'), 'true')
  assert.equal((await replay.json()).analysisId, initial.analysisId)
})

test('cancels a queued analysis', async () => {
  const base = await start({ mockDelayMs: 200 })
  await create(base)
  const second = await create(base)
  const task = await second.json()
  const cancelled = await fetch(`${base}/api/v1/change-impact-analyses/${task.analysisId}/cancel`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  })
  assert.equal(cancelled.status, 202)
  assert.equal((await cancelled.json()).status, 'cancelled')
})
