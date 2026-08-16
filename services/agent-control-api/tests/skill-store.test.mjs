import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { SkillStore, validateSkillSnapshot } from '../skill-store.mjs'

const catalog = {
  servers: [{ id: 'cmdb', status: 'available', tools: [{
    name: 'get_ci', description: 'Get a CI.',
    inputSchema: { type: 'object', required: ['ci_id'], properties: { ci_id: { type: 'string' } } },
  }] }],
}

function input(content = '# Inspect\n\nCall CMDB `get_ci`.') {
  return {
    name: 'inspect-demo-service',
    description: 'Inspect a demo application service using CMDB evidence.',
    content,
    references: { 'rules.md': '# Rules\n' },
    selectedTools: [{ server: 'cmdb', tool: 'get_ci' }],
    interface: {
      displayName: 'Demo inspection',
      shortDescription: 'Inspect demo application health with CMDB evidence',
      defaultPrompt: 'Use $inspect-demo-service to inspect the demo application.',
    },
  }
}

test('stores immutable revisions and publishes or rolls back validated skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bankops-skill-store-'))
  const store = new SkillStore(root)
  await store.initialize()
  const created = await store.create(input(), catalog)
  assert.equal(created.revision, 1)
  assert.match(created.references['mcp-tools.generated.md'], /cmdb\.get_ci/)
  assert.equal(validateSkillSnapshot(created, catalog).valid, true)

  const updated = await store.update(created.name, { ...input('# Inspect v2'), expectedRevision: 1 }, catalog)
  assert.equal(updated.revision, 2)
  await assert.rejects(() => store.update(created.name, { ...input(), expectedRevision: 1 }, catalog), /expectedRevision/)

  const published = await store.publish(created.name, 2, catalog)
  assert.equal(published.skill.publishedRevision, 2)
  const rolledBack = await store.rollback(created.name, 1, catalog)
  assert.equal(rolledBack.skill.publishedRevision, 1)
  assert.deepEqual((await store.get(created.name, 2)).references['rules.md'], '# Rules\n')
})

test('rejects unknown MCP tool dependencies during publish validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bankops-skill-store-'))
  const store = new SkillStore(root)
  await store.initialize()
  const created = await store.create({
    ...input(), selectedTools: [{ server: 'cmdb', tool: 'does_not_exist' }],
  }, catalog)
  const validation = validateSkillSnapshot(created, catalog)
  assert.equal(validation.valid, false)
  assert.match(validation.issues.find(item => item.code === 'unknown_tool').message, /does_not_exist/)
  await assert.rejects(() => store.publish(created.name, 1, catalog), /validation failed/)
})
