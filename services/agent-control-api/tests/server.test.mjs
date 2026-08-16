import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

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
    runnerOptions: { mode: 'mock', mockDelayMs: options.mockDelayMs ?? 10 },
    concurrency: 1,
    catalog: options.catalog,
  })
  await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve))
  servers.push(api.server)
  return `http://127.0.0.1:${api.server.address().port}`
}

const fakeCatalog = {
  async get() {
    return { schemaVersion: '1.0', generatedAt: '2026-08-15T00:00:00.000Z', summary: {
      serverCount: 1, availableServerCount: 1, toolCount: 1,
    }, servers: [{ id: 'cmdb', displayName: 'CMDB', status: 'available', tools: [{
      name: 'get_ci', description: 'Get a CI.', inputSchema: {
        type: 'object', required: ['ci_id'], properties: { ci_id: { type: 'string' } },
      },
    }] }] }
  },
}

async function createInspection(base, headers = {}) {
  return fetch(`${base}/api/v1/system-inspections`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      serviceId: 'SVC-PAYMENT-GATEWAY',
      environment: 'production',
      requestedBy: 'test-suite',
    }),
  })
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
  const studio = await fetch(`${base}/skill-studio`, { redirect: 'manual' })
  assert.equal(studio.status, 308)
  assert.equal(studio.headers.get('location'), 'http://127.0.0.1:8080/skill-studio')
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

test('creates and completes a system inspection independently from change analysis', async () => {
  const base = await start()
  const created = await createInspection(base, { 'idempotency-key': 'same-business-key' })
  assert.equal(created.status, 202)
  assert.match(created.headers.get('location'), /^\/api\/v1\/system-inspections\/sia_/)
  const initial = await created.json()
  assert.equal(initial.serviceId, 'SVC-PAYMENT-GATEWAY')

  let current
  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(`${base}/api/v1/system-inspections/${initial.inspectionId}`, {
      headers: { authorization: 'Bearer test-token' },
    })
    current = await response.json()
    if (current.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(current.status, 'completed')
  assert.equal(current.result.healthStatus, 'UNDETERMINED')
  assert.equal(current.result.serviceId, 'SVC-PAYMENT-GATEWAY')

  const change = await create(base, { 'idempotency-key': 'same-business-key' })
  assert.equal(change.status, 202)
  assert.notEqual((await change.json()).analysisId, initial.inspectionId)
})

test('exposes the MCP catalog and versioned Skill lifecycle', async () => {
  const base = await start({ catalog: fakeCatalog })
  const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }
  const catalogResponse = await fetch(`${base}/api/v1/mcp-catalog`, { headers })
  assert.equal(catalogResponse.status, 200)
  assert.equal((await catalogResponse.json()).summary.toolCount, 1)

  const body = {
    name: 'inspect-demo-service',
    description: 'Inspect a demo service using registered CMDB evidence.',
    content: '# Workflow\n\nCall `get_ci` with the requested CI.',
    selectedTools: [{ server: 'cmdb', tool: 'get_ci' }],
    interface: {
      displayName: 'Demo inspection',
      shortDescription: 'Inspect demo service health with registered CMDB evidence',
      defaultPrompt: 'Use $inspect-demo-service to inspect this service.',
    },
  }
  const created = await fetch(`${base}/api/v1/skills`, { method: 'POST', headers, body: JSON.stringify(body) })
  assert.equal(created.status, 201)
  assert.equal((await created.json()).revision, 1)

  const validation = await fetch(`${base}/api/v1/skills/inspect-demo-service/validate`, { method: 'POST', headers })
  assert.equal((await validation.json()).valid, true)
  const published = await fetch(`${base}/api/v1/skills/inspect-demo-service/publish`, { method: 'POST', headers })
  const publishedBody = await published.json()
  assert.equal(published.status, 200)
  assert.equal(publishedBody.publishedRevision, 1)

  const updated = await fetch(`${base}/api/v1/skills/inspect-demo-service`, {
    method: 'PUT', headers, body: JSON.stringify({ ...body, content: '# Workflow v2', expectedRevision: 1 }),
  })
  assert.equal((await updated.json()).revision, 2)
  const versions = await fetch(`${base}/api/v1/skills/inspect-demo-service/versions`, { headers })
  assert.deepEqual((await versions.json()).revisions, [1, 2])
})
