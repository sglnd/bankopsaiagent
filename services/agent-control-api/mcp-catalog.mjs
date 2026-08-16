const DEFAULT_PROTOCOL_VERSION = '2025-03-26'

function parseRpcPayload(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const messages = trimmed.split(/\r?\n\r?\n/).flatMap(block =>
    block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()),
  )
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(messages[index]) } catch {}
  }
  throw new Error('MCP endpoint returned an unsupported response')
}

async function rpc(fetchImpl, url, id, method, params, sessionId, signal) {
  const response = await fetchImpl(url, {
    method: 'POST', signal,
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  const payload = parseRpcPayload(text)
  if (payload.error) throw new Error(`${method} returned MCP error: ${JSON.stringify(payload.error).slice(0, 500)}`)
  return { payload, sessionId: response.headers.get('mcp-session-id') ?? sessionId }
}

export class McpCatalog {
  constructor(options = {}) {
    this.servers = options.servers ?? []
    this.fetch = options.fetch ?? globalThis.fetch
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.ttlMs = Math.max(1_000, Number(options.ttlMs ?? 60_000))
    this.timeoutMs = Math.max(500, Number(options.timeoutMs ?? 5_000))
    this.cached = undefined
    this.pending = undefined
  }

  async get({ refresh = false } = {}) {
    if (!refresh && this.cached && Date.now() - this.cached.cachedAtMs < this.ttlMs) return this.cached.value
    if (!refresh && this.pending) return this.pending
    this.pending = this.#load().finally(() => { this.pending = undefined })
    return this.pending
  }

  async #load() {
    const generatedAt = new Date().toISOString()
    const servers = await Promise.all(this.servers.map(server => this.#loadServer(server)))
    const value = {
      schemaVersion: '1.0', generatedAt,
      summary: {
        serverCount: servers.length,
        availableServerCount: servers.filter(item => item.status === 'available').length,
        toolCount: servers.reduce((sum, item) => sum + item.tools.length, 0),
      },
      servers,
    }
    this.cached = { cachedAtMs: Date.now(), value }
    return value
  }

  async #loadServer(server) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const initialized = await rpc(this.fetch, server.url, 1, 'initialize', {
        protocolVersion: this.protocolVersion,
        capabilities: {},
        clientInfo: { name: 'bankops-skill-studio', version: '1.0.0' },
      }, undefined, controller.signal)
      const listed = await rpc(this.fetch, server.url, 2, 'tools/list', {}, initialized.sessionId, controller.signal)
      const tools = (listed.payload.result?.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      })).sort((left, right) => left.name.localeCompare(right.name))
      return { id: server.id, displayName: server.displayName ?? server.id, status: 'available', tools }
    } catch (error) {
      return {
        id: server.id, displayName: server.displayName ?? server.id,
        status: 'unavailable', tools: [], error: String(error?.message ?? error).slice(0, 1000),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function catalogServersFromEnv(env = process.env) {
  return [
    { id: 'changeinfo', displayName: 'ChangeInfo', url: env.BANKOPS_CHANGEINFO_MCP_URL ?? 'http://bankops-changeinfo-mcp:8941/mcp' },
    { id: 'cmdb', displayName: 'CMDB', url: env.BANKOPS_CMDB_MCP_URL ?? 'http://bankops-cmdb-mcp:8942/mcp' },
    { id: 'alertinfo', displayName: 'AlertInfo', url: env.BANKOPS_ALERTINFO_MCP_URL ?? 'http://bankops-alertinfo-mcp:8943/mcp' },
    { id: 'perfinfo', displayName: 'PerfInfo', url: env.BANKOPS_PERFINFO_MCP_URL ?? 'http://bankops-perfinfo-mcp:8944/mcp' },
    { id: 'knowledge', displayName: 'Knowledge', url: env.BANKOPS_KNOWLEDGE_MCP_URL ?? 'http://bankops-knowledge-mcp:8952/mcp' },
    { id: 'memory', displayName: 'Memory', url: env.BANKOPS_MEMORY_MCP_URL ?? 'http://bankops-memory-mcp:8953/mcp' },
  ]
}
