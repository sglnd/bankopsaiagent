import { randomUUID } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server'

export function createMcpHttpServer({ name, port, instructions, registerTools, allowedHosts }) {
  const app = createMcpExpressApp({ host:'0.0.0.0', allowedHosts:['localhost','127.0.0.1',...allowedHosts] })
  const sessions = new Map()
  app.get('/health', (_request, response) => response.json({ status:'ok', service:name }))
  app.all('/mcp', async (request, response) => {
    try {
      const sessionId = request.headers['mcp-session-id']
      if (typeof sessionId === 'string' && sessions.has(sessionId)) return await sessions.get(sessionId).handleRequest(request, response, request.body)
      if (!sessionId && isInitializeRequest(request.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator:() => randomUUID(), enableJsonResponse:true,
          onsessioninitialized:id => sessions.set(id, transport),
        })
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId) }
        const server = new McpServer({ name, version:'0.1.0' }, { instructions })
        registerTools(server)
        await server.connect(transport)
        return await transport.handleRequest(request, response, request.body)
      }
      response.status(400).json({ jsonrpc:'2.0', error:{ code:-32000, message:'Missing or invalid MCP session' }, id:null })
    } catch (error) {
      console.error(error)
      if (!response.headersSent) response.status(500).json({ jsonrpc:'2.0', error:{ code:-32603, message:'Internal server error' }, id:null })
    }
  })
  return app.listen(port, '0.0.0.0', () => console.log(`${name} listening on 0.0.0.0:${port}`))
}

export function jsonResult(value) {
  return { content:[{ type:'text', text:JSON.stringify(value, null, 2) }], structuredContent:value }
}

export function errorResult(error) {
  return { isError:true, content:[{ type:'text', text:`BankOps platform request failed: ${error instanceof Error ? error.message : String(error)}` }] }
}
