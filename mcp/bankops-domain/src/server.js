import { randomUUID } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server'
import { registerAlertInfo } from './domains/alertinfo.js'
import { registerChangeInfo } from './domains/changeinfo.js'
import { registerCmdb } from './domains/cmdb.js'
import { registerPerfInfo } from './domains/perfinfo.js'

const domain = process.env.BANKOPS_DOMAIN ?? 'changeinfo'
const port = Number(process.env.PORT ?? 8941)
const registrars = { changeinfo: registerChangeInfo, cmdb: registerCmdb, alertinfo: registerAlertInfo, perfinfo: registerPerfInfo }
const register = registrars[domain]
if (!register) throw new Error(`Unsupported BANKOPS_DOMAIN: ${domain}`)

function buildServer() {
  const server = new McpServer({ name: `bankops-${domain}-mcp`, version: '0.1.0' }, {
    instructions: `BankOps ${domain} test data service. Return only observed Elasticsearch data and preserve source identifiers and timestamps.`,
  })
  register(server)
  return server
}

const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: ['localhost', '127.0.0.1', 'bankops-changeinfo-mcp', 'bankops-cmdb-mcp', 'bankops-alertinfo-mcp', 'bankops-perfinfo-mcp'],
})
const sessions = new Map()

app.get('/health', (_req, res) => res.json({ status: 'ok', domain }))
app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id']
    if (typeof sessionId === 'string' && sessions.has(sessionId)) {
      await sessions.get(sessionId).handleRequest(req, res, req.body)
      return
    }
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: id => sessions.set(id, transport),
      })
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await buildServer().connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing or invalid MCP session' }, id: null })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
  }
})

app.listen(port, '0.0.0.0', () => console.log(`bankops-${domain}-mcp listening on 0.0.0.0:${port}/mcp`))
