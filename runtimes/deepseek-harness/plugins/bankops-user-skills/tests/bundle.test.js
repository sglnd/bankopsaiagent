import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

test('loads only the published user skill revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bankops-user-skills-'))
  const revision = join(root, 'inspect-demo', 'revisions', '2')
  await mkdir(revision, { recursive: true })
  await writeFile(join(root, 'inspect-demo', 'metadata.json'), JSON.stringify({ publishedRevision: 2 }))
  await writeFile(join(revision, 'SKILL.md'), '---\nname: inspect-demo\ndescription: Inspect a demo service.\n---\n\n# Demo\n')
  await writeFile(join(revision, 'authoring.json'), JSON.stringify({ selectedTools: [{ server: 'cmdb', tool: 'get_ci' }] }))
  const previous = process.env.BANKOPS_USER_SKILL_ROOT
  process.env.BANKOPS_USER_SKILL_ROOT = root
  let registration
  try { apply({ skills: { register(value) { registration = value } } }) } finally {
    if (previous === undefined) delete process.env.BANKOPS_USER_SKILL_ROOT
    else process.env.BANKOPS_USER_SKILL_ROOT = previous
  }
  assert.equal(registration.name, 'inspect-demo')
  assert.match(registration.resourceBase.path, /revisions\/2$/)
  assert.match(registration.content, /# Demo/)
})
