import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)

test('declares the two access-controlled MCP clients', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(patch, /id: bankops-knowledge-mcp/)
  assert.match(patch, /id: bankops-memory-mcp/)
  assert.match(patch, /inject: \[tools\]/)
  assert.match(patch, /Save or forget long-term memory only/)
})
