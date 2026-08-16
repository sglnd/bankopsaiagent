import assert from 'node:assert/strict'
import { test } from 'node:test'

import { catalogServersFromEnv, McpCatalog } from '../mcp-catalog.mjs'

test('includes knowledge and memory in the default catalog', () => {
  const servers = catalogServersFromEnv({})
  assert.deepEqual(servers.map(server => server.id), ['changeinfo', 'cmdb', 'alertinfo', 'perfinfo', 'knowledge', 'memory'])
})

test('discovers MCP tools and keeps unavailable servers visible', async () => {
  const calls = []
  const catalog = new McpCatalog({
    servers: [
      { id: 'cmdb', displayName: 'CMDB', url: 'http://cmdb.test/mcp' },
      { id: 'offline', displayName: 'Offline', url: 'http://offline.test/mcp' },
    ],
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      if (url.includes('offline')) throw new Error('connection refused')
      const request = JSON.parse(options.body)
      if (request.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200, headers: { 'mcp-session-id': 'session-1' },
        })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{
        name: 'get_ci', description: 'Get a CI.',
        inputSchema: { type: 'object', required: ['ci_id'], properties: { ci_id: { type: 'string' } } },
      }] } }), { status: 200 })
    },
  })
  const result = await catalog.get()
  assert.equal(result.summary.serverCount, 2)
  assert.equal(result.summary.availableServerCount, 1)
  assert.equal(result.summary.toolCount, 1)
  assert.equal(result.servers[0].tools[0].name, 'get_ci')
  assert.equal(result.servers[1].status, 'unavailable')
  assert.equal(calls.filter(item => item.url.includes('cmdb')).length, 2)
})
