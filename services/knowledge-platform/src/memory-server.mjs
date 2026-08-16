import { randomUUID } from 'node:crypto'
import * as z from 'zod/v4'
import { actorContext } from './config.mjs'
import { esRequest, ensureIndices, MEMORY_INDEX, sourceHits } from './elasticsearch.mjs'
import { createMcpHttpServer, errorResult, jsonResult } from './mcp-server.mjs'

const port = Number(process.env.PORT ?? 8953)

function identityFilters(actor) {
  return [{ term:{ tenant_id:actor.tenantId } }, { term:{ user_id:actor.userId } }, { term:{ workspace_id:actor.workspaceId } }, { term:{ status:'ACTIVE' } }]
}

function registerMemoryTools(server) {
  server.registerTool('recall_memories', {
    description:'检索当前用户在当前工作区的长期上下文，例如偏好、负责系统、既有决定和已确认约束。回答依赖用户上下文的问题前调用。',
    inputSchema:z.object({ query:z.string().min(2).max(500), memory_type:z.enum(['PREFERENCE','RESPONSIBILITY','DECISION','CONSTRAINT','NOTE']).optional(), limit:z.number().int().min(1).max(20).default(8) }),
  }, async ({ query, memory_type, limit }) => { try {
    const actor = actorContext(), filters = identityFilters(actor)
    if (memory_type) filters.push({ term:{ memory_type } })
    const result = await esRequest(`/${MEMORY_INDEX}/_search`, { method:'POST', body:JSON.stringify({ size:limit, sort:[{ _score:'desc' },{ updated_at:'desc' }],
      query:{ bool:{ must:[{ match:{ content:{ query, operator:'or' } } }], filter:filters, must_not:[{ range:{ expires_at:{ lte:'now' } } }] } } }) })
    return jsonResult({ query, memories:sourceHits(result) })
  } catch (error) { return errorResult(error) } })

  server.registerTool('remember_memory', {
    description:'在用户明确要求记住，或明确确认这是长期有效信息时，保存当前用户的长期上下文。不得保存密码、Token、私钥或一次性敏感数据。',
    inputSchema:z.object({ content:z.string().min(3).max(4000), memory_type:z.enum(['PREFERENCE','RESPONSIBILITY','DECISION','CONSTRAINT','NOTE']), importance:z.number().int().min(1).max(5).default(3), source_session_id:z.string().max(128).optional(), expires_at:z.iso.datetime().optional() }),
  }, async input => { try {
    const actor = actorContext(), now = new Date().toISOString(), memoryId = `mem_${randomUUID()}`
    const memory = { memory_id:memoryId, tenant_id:actor.tenantId, user_id:actor.userId, workspace_id:actor.workspaceId,
      memory_type:input.memory_type, content:input.content, status:'ACTIVE', source_type:'DSH_EXPLICIT',
      source_session_id:input.source_session_id, importance:input.importance, approved_by:actor.userId, created_at:now, updated_at:now, expires_at:input.expires_at }
    await esRequest(`/${MEMORY_INDEX}/_doc/${encodeURIComponent(memoryId)}?refresh=true`, { method:'PUT', body:JSON.stringify(memory) })
    return jsonResult({ saved:true, memory })
  } catch (error) { return errorResult(error) } })

  server.registerTool('list_recent_memories', {
    description:'列出当前用户在当前工作区最近保存的长期记忆，便于检查 Agent 持有的上下文。',
    inputSchema:z.object({ limit:z.number().int().min(1).max(50).default(20) }),
  }, async ({ limit }) => { try {
    const actor = actorContext()
    const result = await esRequest(`/${MEMORY_INDEX}/_search`, { method:'POST', body:JSON.stringify({ size:limit, sort:[{ updated_at:'desc' }], query:{ bool:{ filter:identityFilters(actor) } } }) })
    return jsonResult({ memories:sourceHits(result) })
  } catch (error) { return errorResult(error) } })

  server.registerTool('forget_memory', {
    description:'按记忆标识停用当前用户自己的长期记忆。仅在用户明确要求忘记或删除该记忆时调用。',
    inputSchema:z.object({ memory_id:z.string().min(1) }),
  }, async ({ memory_id }) => { try {
    const actor = actorContext()
    const current = await esRequest(`/${MEMORY_INDEX}/_search`, { method:'POST', body:JSON.stringify({ size:1, query:{ bool:{ filter:[...identityFilters(actor),{ term:{ memory_id } }] } } }) })
    if (!current.hits?.hits?.length) return jsonResult({ forgotten:false, memory_id, reason:'not_found_or_not_owned' })
    await esRequest(`/${MEMORY_INDEX}/_update/${encodeURIComponent(memory_id)}?refresh=true`, { method:'POST', body:JSON.stringify({ doc:{ status:'FORGOTTEN', updated_at:new Date().toISOString() } }) })
    return jsonResult({ forgotten:true, memory_id })
  } catch (error) { return errorResult(error) } })
}

await ensureIndices()
createMcpHttpServer({
  name:'bankops-memory-mcp', port,
  instructions:'Memory is scoped to the authenticated BankOps user and workspace. Recall when relevant. Store or forget only on explicit user intent. Never store secrets, credentials, raw operational evidence, or temporary task state.',
  registerTools:registerMemoryTools,
  allowedHosts:['memory-mcp','bankops-memory-mcp'],
})
