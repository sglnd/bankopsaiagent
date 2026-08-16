import express from 'express'
import * as z from 'zod/v4'
import { actorContext } from './config.mjs'
import { ensurePlatformSchema, pool } from './db.mjs'
import { esRequest, ensureIndices, KNOWLEDGE_CHUNK_INDEX, KNOWLEDGE_DOCUMENT_INDEX, sourceHits } from './elasticsearch.mjs'
import { createMcpHttpServer, errorResult, jsonResult } from './mcp-server.mjs'

const port = Number(process.env.PORT ?? 8952)

function accessFilter(actor) {
  return { bool:{ should:[
    { terms:{ allowed_user_ids:[actor.userId] } },
    { terms:{ allowed_department_ids:[actor.departmentId] } },
    ...(actor.roles.length ? [{ terms:{ allowed_roles:actor.roles } }] : []),
  ], minimum_should_match:1 } }
}

async function contextFilter(actor, contextId) {
  if (!contextId) return null
  const result = await pool.query(
    `SELECT a.document_id, a.document_version FROM knowledge_contexts c
     JOIN knowledge_context_attachments a ON a.tenant_id=c.tenant_id AND a.context_id=c.context_id
     JOIN documents d ON d.tenant_id=a.tenant_id AND d.document_id=a.document_id AND d.version=a.document_version
     WHERE c.tenant_id=$1 AND c.context_id=$2 AND c.user_id=$3 AND c.status='ACTIVE'
       AND (c.expires_at IS NULL OR c.expires_at > now()) AND d.status='PUBLISHED'`,
    [actor.tenantId, contextId, actor.userId],
  )
  if (!result.rows.length) throw new Error('knowledge context not found, expired, or has no published attachments')
  return { bool:{ should:result.rows.map(row => ({ bool:{ filter:[
    { term:{ document_id:row.document_id } }, { term:{ document_version:row.document_version } },
  ] } })), minimum_should_match:1 } }
}

async function searchKnowledge(query, limit = 8, contextId = null, actor = actorContext()) {
  const filters = [{ term:{ tenant_id:actor.tenantId } }, accessFilter(actor)]
  const context = await contextFilter(actor, contextId)
  if (context) filters.push(context)
  const result = await esRequest(`/${KNOWLEDGE_CHUNK_INDEX}/_search`, { method:'POST', body:JSON.stringify({
    size:limit,
    query:{ bool:{ must:[{ multi_match:{ query, fields:['title^3','section^2','content'], type:'best_fields' } }], filter:filters } },
    highlight:{ fields:{ content:{ fragment_size:260, number_of_fragments:2 } } },
    _source:['chunk_id','document_id','document_version','title','section','content','page_number','chunk_order','classification','content_sha256'],
  }) })
  return sourceHits(result)
}

async function getKnowledgeDocument(documentId, version = '1') {
  const actor = actorContext()
  const result = await esRequest(`/${KNOWLEDGE_DOCUMENT_INDEX}/_search`, { method:'POST', body:JSON.stringify({
    size:1, query:{ bool:{ filter:[
      { term:{ tenant_id:actor.tenantId } }, { term:{ document_id:documentId } }, { term:{ version } }, accessFilter(actor),
    ] } },
  }) })
  return result.hits?.hits?.[0]?._source ?? null
}

function registerKnowledgeTools(server) {
  server.registerTool('search_knowledge', {
    description:'在当前用户有权访问的本地知识库中检索运维制度、操作手册、应急预案和技术文档。返回可引用的文档、分块与内容哈希。',
    inputSchema:z.object({ query:z.string().min(2).max(500), limit:z.number().int().min(1).max(20).default(8) }),
  }, async ({ query, limit }) => { try { return jsonResult({ query, matches:await searchKnowledge(query, limit) }) } catch (error) { return errorResult(error) } })

  server.registerTool('search_session_knowledge', {
    description:'只在指定知识上下文绑定的附件中检索。用户从 Portal 创建 ctx_ 开头的上下文后，应优先使用此工具分析这些附件。',
    inputSchema:z.object({ context_id:z.string().regex(/^ctx_[0-9a-f-]{36}$/), query:z.string().min(2).max(500), limit:z.number().int().min(1).max(20).default(8) }),
  }, async ({ context_id, query, limit }) => { try { return jsonResult({ context_id, query, matches:await searchKnowledge(query, limit, context_id) }) } catch (error) { return errorResult(error) } })

  server.registerTool('get_knowledge_document', {
    description:'按文档标识读取当前用户有权访问的知识文档元数据。用于核实文档版本、分类、发布时间和内容哈希。',
    inputSchema:z.object({ document_id:z.string().min(1), version:z.string().default('1') }),
  }, async ({ document_id, version }) => { try {
    const document = await getKnowledgeDocument(document_id, version)
    return jsonResult(document ? { found:true, document } : { found:false, document_id, version })
  } catch (error) { return errorResult(error) } })

  server.registerTool('list_knowledge_documents', {
    description:'列出当前用户可访问的近期知识文档，适合先了解知识库覆盖范围再进行检索。',
    inputSchema:z.object({ limit:z.number().int().min(1).max(50).default(20) }),
  }, async ({ limit }) => { try {
    const actor = actorContext()
    const result = await esRequest(`/${KNOWLEDGE_DOCUMENT_INDEX}/_search`, { method:'POST', body:JSON.stringify({
      size:limit, sort:[{ published_at:'desc' }], query:{ bool:{ filter:[{ term:{ tenant_id:actor.tenantId } },{ term:{ status:'PUBLISHED' } },accessFilter(actor)] } },
    }) })
    return jsonResult({ documents:sourceHits(result) })
  } catch (error) { return errorResult(error) } })
}

const mcpServer = createMcpHttpServer({
  name:'bankops-knowledge-mcp', port,
  instructions:'Search only access-controlled BankOps knowledge. For ctx_ attachment contexts use search_session_knowledge. Cite document_id, version, chunk_id, page_number when present, and content_sha256.',
  registerTools:registerKnowledgeTools,
  allowedHosts:['knowledge-mcp','bankops-knowledge-mcp'],
})

const app = express()
app.get('/health', (_request, response) => response.json({ status:'ok', service:'bankops-knowledge-rest' }))
app.get('/api/v1/knowledge/search', async (request, response) => {
  const query = String(request.query.q || '').trim(), contextId = String(request.query.contextId || '').trim() || null
  if (query.length < 2) return response.status(400).json({ error:'invalid_query', message:'q must contain at least 2 characters' })
  try { response.json({ query, contextId, matches:await searchKnowledge(query, Math.min(20, Math.max(1, Number(request.query.limit ?? 8))), contextId, actorContext(request)) }) }
  catch (error) { response.status(error.statusCode ?? 502).json({ error:error.statusCode === 401 ? 'unauthorized' : 'knowledge_search_failed', message:error.message }) }
})

await ensurePlatformSchema()
await ensureIndices()
app.listen(port + 100, '0.0.0.0', () => console.log(`bankops-knowledge REST listening on 0.0.0.0:${port + 100}`))
mcpServer.on('error', error => console.error(error))
