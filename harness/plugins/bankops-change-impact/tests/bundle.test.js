import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { apply, inject, name } from '../index.js'

const root = new URL('../', import.meta.url)

test('declares an installable dsh bundle pinned to the upstream release', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.name, '@bankops/dsh-change-impact')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies?.['@deepseek-ai/dsh-mcp-client'], undefined)
})

test('registers the change impact skill through the Harness skill registry', () => {
  let registration
  const ctx = {
    skills: {
      register(value) {
        registration = value
      },
    },
  }

  apply(ctx)

  assert.equal(name, 'bankops-change-impact')
  assert.deepEqual(inject, ['skills'])
  assert.equal(registration.name, 'change-impact-analysis')
  assert.match(registration.content, /不得虚构指标值/)
  assert.match(registration.content, /数据不足以判断时/)
})

test('contributes only its domain skill', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /id: bankops-change-impact-skill/)
  assert.doesNotMatch(patch, /dsh-mcp-client/)
  assert.doesNotMatch(patch, /id: system-prompt/)
})

test('ships the three required evaluation contracts', async () => {
  const cases = await Promise.all(
    ['high-risk', 'low-risk', 'insufficient-data'].map(async id =>
      JSON.parse(await readFile(new URL(`evals/${id}.json`, root), 'utf8')),
    ),
  )
  assert.deepEqual(cases.map(item => item.caseId), ['high-risk', 'low-risk', 'insufficient-data'])
  assert.equal(cases[2].expected.mustNotFabricate, true)
})
