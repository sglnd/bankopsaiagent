const protocolVersion = process.env.MCP_PROTOCOL_VERSION ?? '2025-03-26'

const cases = [
  { name: 'changeinfo', port: process.env.CHANGEINFO_PORT ?? '8941', tool: 'get_change', arguments: { change_id: 'CHG20260814001' }, expect: 'APP-PAY-GW' },
  { name: 'cmdb', port: process.env.CMDB_PORT ?? '8942', tool: 'get_topology', arguments: { ci_ids: ['APP-PAY-GW', 'K8S-DEP-PAY-GW'], depth: 2 }, expect: 'DB-PAY-ORDERS' },
  { name: 'cmdb-system-inventory', port: process.env.CMDB_PORT ?? '8942', tool: 'get_service_inventory', arguments: { service_id: 'SVC-PAYMENT-GATEWAY', environment: 'production', include_external_dependencies: true }, expect: 'K8S-NODE-PAY-01' },
  { name: 'alertinfo', port: process.env.ALERTINFO_PORT ?? '8943', tool: 'summarize_alerts', arguments: { ci_ids: ['APP-PAY-GW', 'K8S-DEP-PAY-GW', 'REDIS-PAY-01'], start_time: '2026-08-12T00:00:00+08:00', end_time: '2026-08-15T00:00:00+08:00' }, expect: 'by_severity' },
  { name: 'perfinfo', port: process.env.PERFINFO_PORT ?? '8944', tool: 'get_performance_summary', arguments: { ci_ids: ['K8S-DEP-PAY-GW', 'REDIS-PAY-01'], metric_names: ['payment_api_p95_ms', 'pod_memory_utilization', 'redis_command_p95_ms'], start_time: '2026-08-14T00:00:00+08:00', end_time: '2026-08-15T00:00:00+08:00' }, expect: 'threshold_breaches' },
  { name: 'perfinfo-capacity', port: process.env.PERFINFO_PORT ?? '8944', tool: 'get_performance_summary', arguments: { ci_ids: ['DB-PAY-ORDERS', 'REDIS-PAY-01', 'KAFKA-PAY-02'], metric_names: ['database_storage_utilization', 'redis_memory_utilization', 'kafka_consumer_lag'], start_time: '2026-08-14T00:00:00+08:00', end_time: '2026-08-15T00:00:00+08:00' }, expect: 'database_storage_utilization' },
  { name: 'changeinfo-firewall', port: process.env.CHANGEINFO_PORT ?? '8941', tool: 'get_change', arguments: { change_id: 'CHG20260814002' }, expect: 'REQ-FW-2026-0814-067' },
  { name: 'cmdb-firewall', port: process.env.CMDB_PORT ?? '8942', tool: 'find_network_path', arguments: { source_ci_id: 'APP-OPENAPI-GW', target_ci_id: 'APP-FRAUD-SCORING', protocol: 'TCP', port: 9443 }, expect: 'FW-CORE-02' },
  { name: 'alertinfo-firewall', port: process.env.ALERTINFO_PORT ?? '8943', tool: 'find_related_incidents', arguments: { ci_ids: ['FW-CORE-02', 'APP-FRAUD-SCORING'] }, expect: 'INC20260602007' },
  { name: 'perfinfo-firewall', port: process.env.PERFINFO_PORT ?? '8944', tool: 'get_performance_summary', arguments: { ci_ids: ['FW-CORE-02', 'APP-FRAUD-SCORING'], metric_names: ['firewall_session_table_utilization', 'ha_policy_sync_delay_ms', 'fraud_score_p95_ms'], start_time: '2026-08-14T00:00:00+08:00', end_time: '2026-08-15T00:00:00+08:00' }, expect: 'fraud_score_p95_ms' },
]

async function rpc(url, id, method, params, sessionId) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} returned ${response.status}: ${text}`)
  return { payload: JSON.parse(text), sessionId: response.headers.get('mcp-session-id') ?? sessionId }
}

for (const testCase of cases) {
  const url = `http://127.0.0.1:${testCase.port}/mcp`
  const initialized = await rpc(url, 1, 'initialize', {
    protocolVersion, capabilities: {}, clientInfo: { name: 'bankops-domain-smoke-test', version: '1.0.0' },
  })
  const listed = await rpc(url, 2, 'tools/list', {}, initialized.sessionId)
  const names = listed.payload.result.tools.map(tool => tool.name)
  if (!names.includes(testCase.tool)) throw new Error(`${testCase.name}: missing ${testCase.tool}; got ${names.join(', ')}`)
  const called = await rpc(url, 3, 'tools/call', { name: testCase.tool, arguments: testCase.arguments }, initialized.sessionId)
  const rendered = JSON.stringify(called.payload)
  if (!rendered.includes(testCase.expect)) throw new Error(`${testCase.name}: response did not contain ${testCase.expect}`)
  console.log(`${testCase.name}: ${names.join(', ')}; ${testCase.tool} succeeded`)
}
