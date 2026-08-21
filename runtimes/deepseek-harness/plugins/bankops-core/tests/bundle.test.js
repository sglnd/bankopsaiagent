import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)

test('declares the shared BankOps bundle', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  assert.equal(manifest.name, '@bankops/dsh-core')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-mcp-client'], '0.1.0-rc.7')
})

test('owns the shared persona and exactly one client per MCP namespace', async () => {
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.match(patch, /^- id: system-prompt/m)
  assert.match(patch, /Never invent unavailable operational data/)
  const ids = [...patch.matchAll(/^    - id: (bankops-[a-z-]+-mcp)$/gm)].map(match => match[1])
  assert.deepEqual(ids, ['bankops-changeinfo-mcp', 'bankops-cmdb-mcp', 'bankops-alertinfo-mcp', 'bankops-perfinfo-mcp'])
  const namespaces = [...patch.matchAll(/^        serverName: ([a-z0-9-]+)$/gm)].map(match => match[1])
  assert.equal(new Set(namespaces).size, namespaces.length)
  assert.equal((patch.match(/failOnStartupError: true/g) ?? []).length, 4)
  assert.doesNotMatch(patch, /host\.docker\.internal/)
})

test('business bundles do not re-declare shared persona or MCP clients', async () => {
  const changePatch = await readFile(new URL('../../bankops-change-impact/cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(changePatch, /id: system-prompt/)
  assert.doesNotMatch(changePatch, /dsh-mcp-client/)
  assert.doesNotMatch(changePatch, /serverName:/)
})
