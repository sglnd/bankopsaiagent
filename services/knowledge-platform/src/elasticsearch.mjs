import { config } from './config.mjs'

export const KNOWLEDGE_DOCUMENT_INDEX = 'bankops-kb-documents-v1'
export const KNOWLEDGE_CHUNK_INDEX = 'bankops-kb-chunks-v1'
export const MEMORY_INDEX = 'bankops-agent-memories-v1'

export async function esRequest(path, options = {}) {
  const response = await fetch(`${config.elasticsearchUrl}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Elasticsearch ${response.status}: ${text.slice(0, 800)}`)
  return text ? JSON.parse(text) : {}
}

export async function ensureIndices() {
  const definitions = {
    [KNOWLEDGE_DOCUMENT_INDEX]: { mappings: { dynamic: true, properties: {
      document_id:{type:'keyword'}, version:{type:'keyword'}, title:{type:'text',fields:{keyword:{type:'keyword'}}}, status:{type:'keyword'},
      classification:{type:'keyword'}, tenant_id:{type:'keyword'}, owner_department_id:{type:'keyword'}, allowed_user_ids:{type:'keyword'},
      allowed_department_ids:{type:'keyword'}, allowed_roles:{type:'keyword'}, minio_bucket:{type:'keyword'}, minio_object_key:{type:'keyword'},
      content_sha256:{type:'keyword'}, media_type:{type:'keyword'}, created_at:{type:'date'}, published_at:{type:'date'},
    } } },
    [KNOWLEDGE_CHUNK_INDEX]: { mappings: { dynamic: true, properties: {
      chunk_id:{type:'keyword'}, document_id:{type:'keyword'}, document_version:{type:'keyword'}, tenant_id:{type:'keyword'},
      title:{type:'text',fields:{keyword:{type:'keyword'}}}, section:{type:'text'}, content:{type:'text'}, page_number:{type:'integer'},
      chunk_order:{type:'integer'}, allowed_user_ids:{type:'keyword'}, allowed_department_ids:{type:'keyword'}, allowed_roles:{type:'keyword'},
      classification:{type:'keyword'}, content_sha256:{type:'keyword'}, created_at:{type:'date'},
    } } },
    [MEMORY_INDEX]: { mappings: { dynamic: true, properties: {
      memory_id:{type:'keyword'}, tenant_id:{type:'keyword'}, user_id:{type:'keyword'}, workspace_id:{type:'keyword'}, memory_type:{type:'keyword'},
      content:{type:'text'}, status:{type:'keyword'}, source_type:{type:'keyword'}, source_session_id:{type:'keyword'}, importance:{type:'byte'},
      approved_by:{type:'keyword'}, created_at:{type:'date'}, updated_at:{type:'date'}, expires_at:{type:'date'},
    } } },
  }
  for (const [index, body] of Object.entries(definitions)) {
    const exists = await fetch(`${config.elasticsearchUrl}/${index}`, { method:'HEAD', signal:AbortSignal.timeout(10_000) })
    if (exists.status === 404) await esRequest(`/${index}`, { method:'PUT', body:JSON.stringify(body) })
    else if (!exists.ok) throw new Error(`Elasticsearch index check failed: ${index} HTTP ${exists.status}`)
  }
}

export function sourceHits(result) {
  return (result.hits?.hits ?? []).map(hit => ({ ...hit._source, score: hit._score, highlights: hit.highlight?.content ?? [] }))
}
