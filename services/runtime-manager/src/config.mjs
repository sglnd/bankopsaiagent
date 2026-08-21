function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`expected a positive integer, received ${value}`)
  return parsed
}

export const config = {
  port: positiveInteger(process.env.PORT, 8970),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://bankops:bankops-local-change-me@postgres:5432/bankops',
  internalToken: process.env.BANKOPS_RUNTIME_INTERNAL_TOKEN ?? '',
  provider: process.env.BANKOPS_RUNTIME_PROVIDER ?? 'docker',
  image: process.env.BANKOPS_RUNTIME_IMAGE ?? 'bankops/deepseek-harness:0.1.0-rc.7',
  dshVersion: process.env.BANKOPS_DSH_VERSION ?? '0.1.0-rc.7',
  dockerSocket: process.env.BANKOPS_DOCKER_SOCKET ?? '/var/run/docker.sock',
  dockerNetwork: process.env.BANKOPS_RUNTIME_NETWORK ?? 'bankops-network',
  stopTimeoutSeconds: positiveInteger(process.env.BANKOPS_RUNTIME_STOP_TIMEOUT_SECONDS, 20),
  runtimeEnvironment: Object.fromEntries(Object.entries({
    BANKOPS_CHANGEINFO_MCP_URL: process.env.BANKOPS_CHANGEINFO_MCP_URL,
    BANKOPS_CMDB_MCP_URL: process.env.BANKOPS_CMDB_MCP_URL,
    BANKOPS_ALERTINFO_MCP_URL: process.env.BANKOPS_ALERTINFO_MCP_URL,
    BANKOPS_PERFINFO_MCP_URL: process.env.BANKOPS_PERFINFO_MCP_URL,
    BANKOPS_KNOWLEDGE_MCP_URL: process.env.BANKOPS_KNOWLEDGE_MCP_URL,
    BANKOPS_MEMORY_MCP_URL: process.env.BANKOPS_MEMORY_MCP_URL,
  }).filter(([, value]) => value)),
}

if (config.provider !== 'docker') throw new Error(`unsupported runtime provider: ${config.provider}`)
