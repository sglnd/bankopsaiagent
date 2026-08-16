const protocolVersion = process.env.MCP_PROTOCOL_VERSION ?? '2025-03-26'

async function rpc(url, id, method, params, sessionId) {
  const response = await fetch(url, {
    method:'POST',
    headers:{ accept:'application/json, text/event-stream', 'content-type':'application/json', ...(sessionId ? {'mcp-session-id':sessionId} : {}) },
    body:JSON.stringify({ jsonrpc:'2.0', id, method, params }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} returned ${response.status}: ${text}`)
  return { payload:JSON.parse(text), sessionId:response.headers.get('mcp-session-id') ?? sessionId }
}

async function connect(port, name) {
  const url = `http://127.0.0.1:${port}/mcp`
  const initialized = await rpc(url, 1, 'initialize', { protocolVersion, capabilities:{}, clientInfo:{ name, version:'1.0.0' } })
  return { url, sessionId:initialized.sessionId }
}

const knowledge = await connect(process.env.KNOWLEDGE_MCP_PORT ?? '8952', 'bankops-knowledge-smoke-test')
const knowledgeTools = await rpc(knowledge.url, 2, 'tools/list', {}, knowledge.sessionId)
const knowledgeNames = knowledgeTools.payload.result.tools.map(tool => tool.name)
for (const expected of ['search_knowledge','search_session_knowledge']) {
  if (!knowledgeNames.includes(expected)) throw new Error(`knowledge: missing ${expected}; got ${knowledgeNames.join(', ')}`)
}
const searched = await rpc(knowledge.url, 3, 'tools/call', { name:'search_knowledge', arguments:{ query:'支付网关 P95 发布验证', limit:5 } }, knowledge.sessionId)
if (!JSON.stringify(searched.payload).includes('payment_api_p95_ms')) throw new Error('knowledge search did not return the uploaded runbook')
const contexts = await (await fetch(`${process.env.FILE_SERVICE_URL ?? 'http://127.0.0.1:8951'}/api/v1/knowledge-contexts`)).json()
const attachmentContext = contexts.contexts.find(item => item.attachments.length)
if (!attachmentContext) throw new Error('knowledge: no attachment context available')
const sessionSearch = await rpc(knowledge.url, 4, 'tools/call', { name:'search_session_knowledge', arguments:{ context_id:attachmentContext.contextId, query:'支付网关 P95', limit:5 } }, knowledge.sessionId)
if (!JSON.stringify(sessionSearch.payload).includes('payment_api_p95_ms')) throw new Error('session knowledge search did not return the bound runbook')
console.log(`knowledge: ${knowledgeNames.join(', ')}; indexed runbook found`)

const memory = await connect(process.env.MEMORY_MCP_PORT ?? '8953', 'bankops-memory-smoke-test')
const memoryTools = await rpc(memory.url, 2, 'tools/list', {}, memory.sessionId)
const memoryNames = memoryTools.payload.result.tools.map(tool => tool.name)
for (const expected of ['remember_memory','recall_memories','forget_memory']) {
  if (!memoryNames.includes(expected)) throw new Error(`memory: missing ${expected}; got ${memoryNames.join(', ')}`)
}
const marker = `KNOWLEDGE_MEMORY_SMOKE_${Date.now()}`
const remembered = await rpc(memory.url, 3, 'tools/call', { name:'remember_memory', arguments:{ content:`${marker} synthetic test record`, memory_type:'NOTE', importance:1 } }, memory.sessionId)
const memoryId = remembered.payload.result.structuredContent.memory.memory_id
try {
  const recalled = await rpc(memory.url, 4, 'tools/call', { name:'recall_memories', arguments:{ query:marker, limit:5 } }, memory.sessionId)
  if (!JSON.stringify(recalled.payload).includes(marker)) throw new Error('memory recall did not return the synthetic record')
} finally {
  const forgotten = await rpc(memory.url, 5, 'tools/call', { name:'forget_memory', arguments:{ memory_id:memoryId } }, memory.sessionId)
  if (!JSON.stringify(forgotten.payload).includes('"forgotten":true')) throw new Error('memory cleanup failed')
}
console.log(`memory: ${memoryNames.join(', ')}; remember/recall/forget lifecycle succeeded`)
