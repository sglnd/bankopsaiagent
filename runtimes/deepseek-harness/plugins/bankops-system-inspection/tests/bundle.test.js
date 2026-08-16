import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { apply, inject, name } from '../index.js'

const root = new URL('../', import.meta.url)

test('declares an installable system inspection bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.name, '@bankops/dsh-system-inspection')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('registers the system inspection skill', () => {
  let registration
  apply({ skills: { register(value) { registration = value } } })
  assert.equal(name, 'bankops-system-inspection')
  assert.deepEqual(inject, ['skills'])
  assert.equal(registration.name, 'inspect-application-system')
  assert.match(registration.content, /根据工具描述和输入 Schema 自主选择具体方法/)
  assert.match(registration.content, /最少充分调用/)
  assert.match(registration.content, /监控缺失不是“健康”/)
})

test('uses the JSONPatch-compatible Cordis patch shape', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /^# yaml-language-server:/)
  assert.match(patch, /id: bankops-system-inspection-skill/)
})
