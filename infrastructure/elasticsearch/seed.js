const esUrl = (process.env.ELASTICSEARCH_URL ?? 'http://elasticsearch:9200').replace(/\/$/, '')
const platformOnly = process.env.BANKOPS_SEED_PLATFORM_ONLY === '1'

const keyword = { type: 'keyword' }
const date = { type: 'date' }
const textKeyword = { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } }

const indices = {
  'bankops-changes-v1': {
    mappings: { dynamic: true, properties: {
      change_id: keyword, change_type: keyword, status: keyword, risk_level: keyword,
      service_ids: keyword, target_ci_ids: keyword, planned_start: date, planned_end: date,
      title: textKeyword, summary: textKeyword,
    } },
  },
  'bankops-cmdb-cis-v1': {
    mappings: { dynamic: true, properties: {
      ci_id: keyword, ci_type: keyword, name: textKeyword, environment: keyword,
      service_id: keyword, status: keyword, criticality: keyword, owner_team: keyword,
      ip_addresses: keyword, security_zone: keyword,
    } },
  },
  'bankops-cmdb-relations-v1': {
    mappings: { dynamic: true, properties: {
      relation_id: keyword, relation_type: keyword, source_ci_id: keyword, target_ci_id: keyword,
      protocol: keyword, port: { type: 'integer' }, status: keyword, valid_from: date, valid_to: date,
    } },
  },
  'bankops-alerts-v1': {
    mappings: { dynamic: true, properties: {
      '@timestamp': date, alert_id: keyword, event_type: keyword, ci_id: keyword, service_id: keyword,
      severity: keyword, status: keyword, source: keyword, rule_id: keyword, fingerprint: keyword,
      title: textKeyword, message: textKeyword,
    } },
  },
  'bankops-incidents-v1': {
    mappings: { dynamic: true, properties: {
      incident_id: keyword, severity: keyword, status: keyword, affected_ci_ids: keyword,
      affected_service_ids: keyword, started_at: date, recovered_at: date,
      title: textKeyword, root_cause: textKeyword,
    } },
  },
  'bankops-performance-v1': {
    mappings: { dynamic: true, properties: {
      '@timestamp': date, ci_id: keyword, service_id: keyword, metric_name: keyword, unit: keyword,
      value: { type: 'double' }, warning_threshold: { type: 'double' }, critical_threshold: { type: 'double' },
      threshold_breached: { type: 'boolean' }, collection_status: keyword, source: keyword,
    } },
  },
  'bankops-kb-documents-v1': {
    mappings: { dynamic: 'strict', properties: {
      document_id: keyword, version: keyword, title: textKeyword, status: keyword,
      classification: keyword, tenant_id: keyword, owner_department_id: keyword,
      allowed_user_ids: keyword, allowed_department_ids: keyword, allowed_roles: keyword,
      minio_bucket: keyword, minio_object_key: keyword, content_sha256: keyword,
      media_type: keyword, created_at: date, published_at: date, valid_from: date, valid_to: date,
    } },
  },
  'bankops-kb-chunks-v1': {
    mappings: { dynamic: 'strict', properties: {
      chunk_id: keyword, document_id: keyword, document_version: keyword,
      tenant_id: keyword, title: textKeyword, section: textKeyword, content: { type: 'text' },
      page_number: { type: 'integer' }, chunk_order: { type: 'integer' },
      allowed_user_ids: keyword, allowed_department_ids: keyword, allowed_roles: keyword,
      classification: keyword, content_sha256: keyword, created_at: date,
    } },
  },
  'bankops-agent-memories-v1': {
    mappings: { dynamic: 'strict', properties: {
      memory_id: keyword, tenant_id: keyword, user_id: keyword, workspace_id: keyword,
      memory_type: keyword, content: { type: 'text' }, status: keyword, source_type: keyword,
      source_session_id: keyword, importance: { type: 'byte' }, approved_by: keyword,
      created_at: date, updated_at: date, expires_at: date,
    } },
  },
}

const platformIndices = new Set([
  'bankops-kb-documents-v1',
  'bankops-kb-chunks-v1',
  'bankops-agent-memories-v1',
])

const changes = [
  {
    _id: 'CHG20260814001', change_id: 'CHG20260814001', change_type: 'application_release',
    title: '支付网关 payment-gateway 4.12.0 生产发布', summary: '修复渠道路由缓存雪崩并升级支付报文签名组件。',
    status: 'approved', environment: 'production', risk_level: 'medium', priority: 'P2',
    service_ids: ['SVC-PAYMENT-GATEWAY'], target_ci_ids: ['APP-PAY-GW', 'K8S-DEP-PAY-GW'],
    planned_start: '2026-08-15T00:30:00+08:00', planned_end: '2026-08-15T01:30:00+08:00',
    requested_by: { user_id: 'u1048', name: '李明', department: '支付平台部' },
    owner_team: '支付平台应用运维组', approvers: [
      { role: 'application_owner', status: 'approved', approved_at: '2026-08-14T10:12:00+08:00' },
      { role: 'operations_manager', status: 'approved', approved_at: '2026-08-14T11:03:00+08:00' },
    ],
    release: { artifact: 'registry.bank.local/payment-gateway:4.12.0', artifact_sha256: 'sha256:5b46e188c18d4c86a4f2bfc9f19f0b43', replicas: 8, strategy: 'canary_then_rolling', canary_percent: 12.5 },
    implementation_steps: [
      { order: 1, action: '冻结发布窗口并确认监控静默策略', expected_minutes: 5 },
      { order: 2, action: '发布 1 个金丝雀 Pod 并执行支付查询探针', expected_minutes: 10 },
      { order: 3, action: '分两批滚动其余 7 个 Pod，maxUnavailable=1', expected_minutes: 25 },
      { order: 4, action: '执行银联、网联、行内三类小额交易验证', expected_minutes: 15 },
    ],
    validation_plan: [
      '交易成功率 5 分钟窗口不低于 99.95%', 'payment_api_p95_ms 不高于 350ms',
      '签名失败错误码 PAY-SIGN-002 不新增', '核心记账下游调用成功率不低于 99.99%',
    ],
    rollback_plan: { method: 'Kubernetes 回滚至 revision 86 / 镜像 4.11.3', estimated_minutes: 12, data_rollback_required: false },
    blackout_conflict: false, business_impact: { channels: ['手机银行', '网银', '开放银行'], customer_facing: true, expected_interruption: '无，滚动发布' },
  },
  {
    _id: 'CHG20260814002', change_id: 'CHG20260814002', change_type: 'firewall_rule',
    title: '开放银行 DMZ 到反欺诈服务生产防火墙策略开通',
    summary: '开放 API 网关节点访问反欺诈实时评分服务的双向 TCP 会话。',
    status: 'approved', environment: 'production', risk_level: 'high', priority: 'P2',
    service_ids: ['SVC-OPENAPI-GW', 'SVC-FRAUD-SCORING'], target_ci_ids: ['FW-CORE-02', 'NETPATH-OPENAPI-FRAUD'],
    planned_start: '2026-08-16T02:00:00+08:00', planned_end: '2026-08-16T03:00:00+08:00',
    requested_by: { user_id: 'u2081', name: '王蕾', department: '开放银行部' }, owner_team: '网络安全运行组',
    approvers: [
      { role: 'application_owner', status: 'approved', approved_at: '2026-08-14T14:20:00+08:00' },
      { role: 'network_security', status: 'approved', approved_at: '2026-08-14T15:41:00+08:00' },
    ],
    firewall_request: {
      source_zone: 'DMZ-OPENAPI', source_cidrs: ['10.20.14.0/27'], destination_zone: 'CORE-APP',
      destination_ips: ['10.60.8.41', '10.60.8.42'], protocol: 'TCP', destination_port: 9443,
      direction: 'DMZ_TO_CORE', requested_rule_id: 'REQ-FW-2026-0814-067', expiration_at: '2027-08-16T03:00:00+08:00',
      nat_required: false, tls_required: true,
    },
    implementation_steps: [
      { order: 1, action: '备份 FW-CORE-02 当前策略并记录命中计数', expected_minutes: 10 },
      { order: 2, action: '下发限定源 CIDR、目标 IP、TCP/9443 的策略', expected_minutes: 10 },
      { order: 3, action: '从两台 API 网关节点分别执行 TLS 与业务探测', expected_minutes: 10 },
      { order: 4, action: '观察拒绝日志、会话数和反欺诈接口错误率', expected_minutes: 20 },
    ],
    validation_plan: ['TLS 证书校验成功', '两台目标节点均可达', '无非申请源地址命中', '反欺诈评分 P95 小于 180ms'],
    rollback_plan: { method: '撤销新策略并恢复变更前策略快照 FWCORE02-20260816-0155', estimated_minutes: 8, data_rollback_required: false },
    blackout_conflict: false, business_impact: { channels: ['开放银行'], customer_facing: true, expected_interruption: '无，开通新链路' },
  },
  {
    _id: 'CHG20260718011', change_id: 'CHG20260718011', change_type: 'application_release', title: '支付网关 4.11.3 生产发布',
    summary: '支付渠道超时重试优化。', status: 'completed', risk_level: 'medium', environment: 'production',
    service_ids: ['SVC-PAYMENT-GATEWAY'], target_ci_ids: ['APP-PAY-GW', 'K8S-DEP-PAY-GW'],
    planned_start: '2026-07-19T00:30:00+08:00', planned_end: '2026-07-19T01:20:00+08:00', actual_end: '2026-07-19T01:48:00+08:00',
    outcome: 'completed_with_incident', incident_ids: ['INC20260719003'], rollback_executed: false,
  },
  {
    _id: 'CHG20260512009', change_id: 'CHG20260512009', change_type: 'firewall_rule', title: '开放银行到客户画像服务策略开通',
    summary: 'DMZ API 网关访问客户画像查询接口。', status: 'completed', risk_level: 'medium', environment: 'production',
    service_ids: ['SVC-OPENAPI-GW'], target_ci_ids: ['FW-CORE-02'], planned_start: '2026-05-13T02:00:00+08:00', planned_end: '2026-05-13T02:40:00+08:00',
    outcome: 'successful', rollback_executed: false,
  },
]

const cis = [
  { _id: 'APP-PAY-GW', ci_id: 'APP-PAY-GW', ci_type: 'application', name: '支付网关应用', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '支付平台应用运维组', rto_minutes: 5, rpo_minutes: 0, business_domains: ['支付', '渠道接入'] },
  { _id: 'MOD-PAY-ACCESS', ci_id: 'MOD-PAY-ACCESS', ci_type: 'application_module', name: '支付接入模块', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '支付平台应用运维组', version: '4.11.3', runtime: 'Java 21', functions: ['报文接入', '协议转换', '幂等校验'] },
  { _id: 'MOD-PAY-ROUTING', ci_id: 'MOD-PAY-ROUTING', ci_type: 'application_module', name: '支付渠道路由模块', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '支付平台应用运维组', version: '4.11.3', runtime: 'Java 21', functions: ['渠道路由', '限流', '失败重试'] },
  { _id: 'MOD-PAY-SIGN', ci_id: 'MOD-PAY-SIGN', ci_type: 'application_module', name: '支付签名模块', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '支付平台应用运维组', version: '2.8.1', runtime: 'Java 21', functions: ['报文签名', '验签'] },
  { _id: 'K8S-DEP-PAY-GW', ci_id: 'K8S-DEP-PAY-GW', ci_type: 'kubernetes_deployment', name: 'payment-gateway', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '支付平台应用运维组', cluster: 'k8s-prod-a', namespace: 'payment-prod', replicas: 8, version: '4.11.3', cpu_request_cores: 2, memory_request_gib: 4 },
  { _id: 'K8S-NODE-PAY-01', ci_id: 'K8S-NODE-PAY-01', ci_type: 'kubernetes_node', name: 'k8s-prod-a-worker-21', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '容器平台组', ip_addresses: ['10.40.21.21'], availability_zone: 'DC-A', cpu_cores: 32, memory_gib: 128, allocatable_storage_gib: 800 },
  { _id: 'K8S-NODE-PAY-02', ci_id: 'K8S-NODE-PAY-02', ci_type: 'kubernetes_node', name: 'k8s-prod-a-worker-22', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '容器平台组', ip_addresses: ['10.40.21.22'], availability_zone: 'DC-B', cpu_cores: 32, memory_gib: 128, allocatable_storage_gib: 800 },
  { _id: 'POD-PAY-GW-01', ci_id: 'POD-PAY-GW-01', ci_type: 'application_instance', name: 'payment-gateway-6f7c8b9d-01', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '支付平台应用运维组', ip_addresses: ['10.244.21.31'], node_ci_id: 'K8S-NODE-PAY-01', version: '4.11.3' },
  { _id: 'POD-PAY-GW-02', ci_id: 'POD-PAY-GW-02', ci_type: 'application_instance', name: 'payment-gateway-6f7c8b9d-02', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '支付平台应用运维组', ip_addresses: ['10.244.22.32'], node_ci_id: 'K8S-NODE-PAY-02', version: '4.11.3' },
  { _id: 'LB-PAY-01', ci_id: 'LB-PAY-01', ci_type: 'load_balancer', name: '支付网关生产负载均衡', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '基础设施网络组', vip: '10.50.1.20', pool: 'payment-gateway-9443' },
  { _id: 'APP-MOBILE-BANK', ci_id: 'APP-MOBILE-BANK', ci_type: 'application', name: '手机银行后端', environment: 'production', service_id: 'SVC-MOBILE-BANK', status: 'active', criticality: 'mission_critical', owner_team: '手机银行应用组' },
  { _id: 'APP-OPENAPI-GW', ci_id: 'APP-OPENAPI-GW', ci_type: 'application', name: '开放银行 API 网关', environment: 'production', service_id: 'SVC-OPENAPI-GW', status: 'active', criticality: 'high', owner_team: '开放银行运维组', security_zone: 'DMZ-OPENAPI', ip_addresses: ['10.20.14.11', '10.20.14.12'] },
  { _id: 'APP-LEDGER', ci_id: 'APP-LEDGER', ci_type: 'application', name: '核心记账服务', environment: 'production', service_id: 'SVC-CORE-LEDGER', status: 'active', criticality: 'mission_critical', owner_team: '核心系统运维组' },
  { _id: 'DB-PAY-ORDERS', ci_id: 'DB-PAY-ORDERS', ci_type: 'database_cluster', name: '支付订单数据库', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '数据库运行组', engine: 'OceanBase', version: '4.3.2', cluster: 'ob-pay-prod', data_classification: 'restricted' },
  { _id: 'DBNODE-PAY-01', ci_id: 'DBNODE-PAY-01', ci_type: 'database_instance', name: 'ob-pay-prod-01', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '数据库运行组', ip_addresses: ['10.70.31.11'], role: 'leader', availability_zone: 'DC-A', storage_gib: 4096 },
  { _id: 'DBNODE-PAY-02', ci_id: 'DBNODE-PAY-02', ci_type: 'database_instance', name: 'ob-pay-prod-02', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'mission_critical', owner_team: '数据库运行组', ip_addresses: ['10.70.32.12'], role: 'follower', availability_zone: 'DC-B', storage_gib: 4096 },
  { _id: 'REDIS-PAY-01', ci_id: 'REDIS-PAY-01', ci_type: 'redis_cluster', name: '支付路由缓存', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', version: '7.2', nodes: 6 },
  { _id: 'REDISNODE-PAY-01', ci_id: 'REDISNODE-PAY-01', ci_type: 'redis_node', name: 'redis-pay-prod-01', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', ip_addresses: ['10.71.11.21'], role: 'master', memory_gib: 64 },
  { _id: 'REDISNODE-PAY-02', ci_id: 'REDISNODE-PAY-02', ci_type: 'redis_node', name: 'redis-pay-prod-02', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', ip_addresses: ['10.71.12.22'], role: 'replica', memory_gib: 64 },
  { _id: 'MQ-PAY-EVENTS', ci_id: 'MQ-PAY-EVENTS', ci_type: 'message_queue', name: '支付事件 Kafka', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', cluster: 'kafka-pay-prod', topics: ['payment-result', 'payment-audit'] },
  { _id: 'KAFKA-PAY-01', ci_id: 'KAFKA-PAY-01', ci_type: 'message_broker', name: 'kafka-pay-prod-01', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', ip_addresses: ['10.72.21.31'], broker_id: 1, storage_gib: 2048 },
  { _id: 'KAFKA-PAY-02', ci_id: 'KAFKA-PAY-02', ci_type: 'message_broker', name: 'kafka-pay-prod-02', environment: 'production', service_id: 'SVC-PAYMENT-GATEWAY', status: 'active', criticality: 'high', owner_team: '中间件运行组', ip_addresses: ['10.72.22.32'], broker_id: 2, storage_gib: 2048 },
  { _id: 'APP-FRAUD-SCORING', ci_id: 'APP-FRAUD-SCORING', ci_type: 'application', name: '反欺诈实时评分服务', environment: 'production', service_id: 'SVC-FRAUD-SCORING', status: 'active', criticality: 'mission_critical', owner_team: '风险科技运维组', security_zone: 'CORE-APP', ip_addresses: ['10.60.8.41', '10.60.8.42'] },
  { _id: 'FW-CORE-02', ci_id: 'FW-CORE-02', ci_type: 'firewall_cluster', name: '核心区边界防火墙集群 02', environment: 'production', status: 'active', criticality: 'mission_critical', owner_team: '网络安全运行组', vendor: 'Huawei', model: 'USG6680E', ha_mode: 'active_standby', management_domain: 'CORE-EDGE' },
  { _id: 'NETPATH-OPENAPI-FRAUD', ci_id: 'NETPATH-OPENAPI-FRAUD', ci_type: 'network_path', name: '开放银行至反欺诈网络路径', environment: 'production', status: 'pending_change', criticality: 'high', owner_team: '网络安全运行组', source_zone: 'DMZ-OPENAPI', destination_zone: 'CORE-APP' },
]

const relations = [
  ['REL-001', 'depends_on', 'APP-MOBILE-BANK', 'APP-PAY-GW', { protocol: 'HTTPS', port: 9443, criticality: 'hard' }],
  ['REL-002', 'depends_on', 'APP-OPENAPI-GW', 'APP-PAY-GW', { protocol: 'HTTPS', port: 9443, criticality: 'hard' }],
  ['REL-003', 'deployed_as', 'APP-PAY-GW', 'K8S-DEP-PAY-GW', { criticality: 'hard' }],
  ['REL-004', 'fronted_by', 'K8S-DEP-PAY-GW', 'LB-PAY-01', { protocol: 'HTTPS', port: 9443, criticality: 'hard' }],
  ['REL-005', 'writes_to', 'APP-PAY-GW', 'DB-PAY-ORDERS', { protocol: 'JDBC', port: 2881, criticality: 'hard' }],
  ['REL-006', 'uses_cache', 'APP-PAY-GW', 'REDIS-PAY-01', { protocol: 'RESP-TLS', port: 6380, criticality: 'hard' }],
  ['REL-007', 'publishes_to', 'APP-PAY-GW', 'MQ-PAY-EVENTS', { protocol: 'SASL_SSL', port: 9093, criticality: 'soft' }],
  ['REL-008', 'calls', 'APP-PAY-GW', 'APP-LEDGER', { protocol: 'gRPC-TLS', port: 9444, criticality: 'hard' }],
  ['REL-009', 'network_path', 'APP-OPENAPI-GW', 'APP-FRAUD-SCORING', { protocol: 'TCP', port: 9443, status: 'pending', path_ci_id: 'NETPATH-OPENAPI-FRAUD', firewall_ci_id: 'FW-CORE-02', source_zone: 'DMZ-OPENAPI', destination_zone: 'CORE-APP', policy_action: 'allow', valid_from: '2026-08-16T02:00:00+08:00', valid_to: '2027-08-16T03:00:00+08:00' }],
  ['REL-010', 'traverses', 'NETPATH-OPENAPI-FRAUD', 'FW-CORE-02', { sequence: 2, criticality: 'hard' }],
  ['REL-011', 'contains', 'APP-PAY-GW', 'MOD-PAY-ACCESS', { criticality: 'hard' }],
  ['REL-012', 'contains', 'APP-PAY-GW', 'MOD-PAY-ROUTING', { criticality: 'hard' }],
  ['REL-013', 'contains', 'APP-PAY-GW', 'MOD-PAY-SIGN', { criticality: 'hard' }],
  ['REL-014', 'deployed_as', 'MOD-PAY-ACCESS', 'K8S-DEP-PAY-GW', { criticality: 'hard' }],
  ['REL-015', 'deployed_as', 'MOD-PAY-ROUTING', 'K8S-DEP-PAY-GW', { criticality: 'hard' }],
  ['REL-016', 'deployed_as', 'MOD-PAY-SIGN', 'K8S-DEP-PAY-GW', { criticality: 'hard' }],
  ['REL-017', 'has_instance', 'K8S-DEP-PAY-GW', 'POD-PAY-GW-01', { criticality: 'hard' }],
  ['REL-018', 'has_instance', 'K8S-DEP-PAY-GW', 'POD-PAY-GW-02', { criticality: 'hard' }],
  ['REL-019', 'runs_on', 'POD-PAY-GW-01', 'K8S-NODE-PAY-01', { criticality: 'hard' }],
  ['REL-020', 'runs_on', 'POD-PAY-GW-02', 'K8S-NODE-PAY-02', { criticality: 'hard' }],
  ['REL-021', 'has_member', 'DB-PAY-ORDERS', 'DBNODE-PAY-01', { criticality: 'hard' }],
  ['REL-022', 'has_member', 'DB-PAY-ORDERS', 'DBNODE-PAY-02', { criticality: 'hard' }],
  ['REL-023', 'has_member', 'REDIS-PAY-01', 'REDISNODE-PAY-01', { criticality: 'hard' }],
  ['REL-024', 'has_member', 'REDIS-PAY-01', 'REDISNODE-PAY-02', { criticality: 'hard' }],
  ['REL-025', 'has_broker', 'MQ-PAY-EVENTS', 'KAFKA-PAY-01', { criticality: 'hard' }],
  ['REL-026', 'has_broker', 'MQ-PAY-EVENTS', 'KAFKA-PAY-02', { criticality: 'hard' }],
].map(([relation_id, relation_type, source_ci_id, target_ci_id, extra]) => ({ _id: relation_id, relation_id, relation_type, source_ci_id, target_ci_id, status: 'active', ...extra }))

const alerts = [
  ['ALT-20260813-001', '2026-08-13T09:42:00+08:00', 'K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'high', 'closed', 'metric_alert', '支付网关 P95 延迟超过 350ms', '连续 8 分钟 P95 为 412-468ms，关联 Redis 超时重试。'],
  ['ALT-20260813-002', '2026-08-13T09:43:12+08:00', 'REDIS-PAY-01', 'SVC-PAYMENT-GATEWAY', 'high', 'closed', 'log_alert', '支付路由缓存超时率升高', 'redis_timeout_total 5 分钟增加 1832 次，客户端连接池等待。'],
  ['ALT-20260814-003', '2026-08-14T07:16:00+08:00', 'K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'medium', 'acknowledged', 'metric_alert', 'Pod 内存使用率接近预警线', '8 个 Pod 中 2 个内存工作集达到 limit 的 82%，尚未发生 OOM。'],
  ['ALT-20260814-004', '2026-08-14T11:06:18+08:00', 'APP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'medium', 'open', 'log_alert', '支付签名失败码出现', 'PAY-SIGN-002 在 10 分钟内出现 19 次，基线同期小于 3 次。'],
  ['ALT-20260814-005', '2026-08-14T12:15:00+08:00', 'DB-PAY-ORDERS', 'SVC-PAYMENT-GATEWAY', 'medium', 'open', 'metric_alert', '支付订单库数据盘容量接近预警线', '集群数据盘使用率达到 78.6%，近 30 天日均增长 18.4GiB。'],
  ['ALT-20260814-006', '2026-08-14T12:22:00+08:00', 'KAFKA-PAY-02', 'SVC-PAYMENT-GATEWAY', 'medium', 'acknowledged', 'metric_alert', '支付审计主题消费积压', 'payment-audit 消费组积压达到 12840 条，恢复速度低于写入速度。'],
  ['ALT-20260812-011', '2026-08-12T22:40:00+08:00', 'FW-CORE-02', 'SVC-NETWORK-SECURITY', 'high', 'closed', 'device_alert', '防火墙会话表使用率超过 75%', '主用节点会话表使用率最高 78.4%，清理异常长连接后恢复至 61%。'],
  ['ALT-20260814-012', '2026-08-14T13:20:00+08:00', 'FW-CORE-02', 'SVC-NETWORK-SECURITY', 'medium', 'acknowledged', 'config_alert', '防火墙策略库存在待整理影子规则', '规则审计发现 14 条影子规则，其中 2 条位于 DMZ_TO_CORE 策略段。'],
  ['ALT-20260814-013', '2026-08-14T14:02:00+08:00', 'APP-FRAUD-SCORING', 'SVC-FRAUD-SCORING', 'high', 'open', 'metric_alert', '反欺诈评分接口 P95 延迟升高', 'P95 从基线 126ms 上升至 224ms，超过 180ms 预警线。'],
  ['ALT-20260814-014', '2026-08-14T14:04:31+08:00', 'APP-FRAUD-SCORING', 'SVC-FRAUD-SCORING', 'medium', 'open', 'log_alert', '模型特征读取超时', 'feature_store_timeout 在 15 分钟内发生 76 次，错误率 0.42%。'],
].map(([alert_id, timestamp, ci_id, service_id, severity, status, event_type, title, message]) => ({
  _id: alert_id, alert_id, '@timestamp': timestamp, ci_id, service_id, severity, status, event_type, title, message,
  source: event_type === 'log_alert' ? 'elasticsearch-rule' : 'prometheus-alertmanager', rule_id: `RULE-${alert_id.slice(-3)}`,
  fingerprint: `${ci_id}:${event_type}:${title}`, environment: 'production', acknowledged_by: status === 'acknowledged' ? 'oncall' : null,
}))

const incidents = [
  { _id: 'INC20260719003', incident_id: 'INC20260719003', title: '支付网关发布后渠道超时重试放大', severity: 'SEV2', status: 'resolved', started_at: '2026-07-19T01:02:00+08:00', recovered_at: '2026-07-19T01:44:00+08:00', duration_minutes: 42, affected_ci_ids: ['APP-PAY-GW', 'K8S-DEP-PAY-GW', 'REDIS-PAY-01'], affected_service_ids: ['SVC-PAYMENT-GATEWAY'], customer_impact: '约 0.18% 支付请求首次响应超时，重试后成功。', root_cause: '新版重试退避参数未区分 Redis 超时，造成缓存故障期间请求放大。', related_change_id: 'CHG20260718011', corrective_actions: ['按依赖类型拆分重试策略', '发布过程增加 Redis 超时率门禁', '金丝雀观察时间延长至 10 分钟'] },
  { _id: 'INC20260602007', incident_id: 'INC20260602007', title: '核心边界防火墙会话同步延迟', severity: 'SEV2', status: 'resolved', started_at: '2026-06-02T10:14:00+08:00', recovered_at: '2026-06-02T10:51:00+08:00', duration_minutes: 37, affected_ci_ids: ['FW-CORE-02'], affected_service_ids: ['SVC-OPENAPI-GW', 'SVC-FRAUD-SCORING'], customer_impact: '部分跨区新建连接失败，存量会话不受影响。', root_cause: 'HA 节点策略同步队列积压与会话表高水位叠加。', corrective_actions: ['变更前检查会话表低于 70%', 'HA 同步延迟纳入网络变更门禁'] },
]

const perf = []
function addSeries(ci_id, service_id, metric_name, unit, warning, critical, values, startHour = 6, breachDirection = 'high') {
  values.forEach((value, index) => perf.push({
    _id: `${ci_id}-${metric_name}-${index}`, '@timestamp': `2026-08-14T${String(startHour + index).padStart(2, '0')}:00:00+08:00`,
    ci_id, service_id, metric_name, unit, value, warning_threshold: warning, critical_threshold: critical,
    threshold_breached: breachDirection === 'low' ? value <= warning : value >= warning,
    threshold_direction: breachDirection, collection_status: 'complete', source: 'prometheus', sample_interval_seconds: 300,
  }))
}
addSeries('K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'payment_api_p95_ms', 'ms', 350, 600, [218, 226, 241, 278, 305, 366, 421, 388])
addSeries('K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'transaction_success_rate', 'percent', 99.95, 99.5, [99.992, 99.988, 99.981, 99.962, 99.954, 99.921, 99.903, 99.948], 6, 'low')
addSeries('K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'pod_memory_utilization', 'percent', 80, 90, [66, 68, 71, 74, 77, 82, 84, 81])
addSeries('K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'pod_cpu_utilization', 'percent', 75, 90, [42, 45, 49, 53, 57, 62, 68, 64])
addSeries('K8S-DEP-PAY-GW', 'SVC-PAYMENT-GATEWAY', 'available_replicas', 'count', 7.9, 7, [8, 8, 8, 8, 8, 8, 7, 8], 6, 'low')
addSeries('K8S-NODE-PAY-01', 'SVC-PAYMENT-GATEWAY', 'node_cpu_utilization', 'percent', 75, 90, [48, 51, 53, 58, 62, 68, 71, 69])
addSeries('K8S-NODE-PAY-01', 'SVC-PAYMENT-GATEWAY', 'node_memory_utilization', 'percent', 80, 90, [61, 63, 66, 69, 72, 76, 81, 79])
addSeries('K8S-NODE-PAY-01', 'SVC-PAYMENT-GATEWAY', 'node_filesystem_utilization', 'percent', 80, 90, [62, 62.4, 62.9, 63.3, 63.8, 64.2, 64.7, 65.1])
addSeries('K8S-NODE-PAY-02', 'SVC-PAYMENT-GATEWAY', 'node_cpu_utilization', 'percent', 75, 90, [44, 46, 48, 51, 55, 57, 61, 59])
addSeries('K8S-NODE-PAY-02', 'SVC-PAYMENT-GATEWAY', 'node_memory_utilization', 'percent', 80, 90, [58, 60, 61, 63, 65, 67, 69, 68])
addSeries('LB-PAY-01', 'SVC-PAYMENT-GATEWAY', 'lb_connection_utilization', 'percent', 70, 85, [45, 48, 51, 55, 59, 63, 68, 66])
addSeries('REDIS-PAY-01', 'SVC-PAYMENT-GATEWAY', 'redis_command_p95_ms', 'ms', 8, 20, [2.8, 3.1, 3.4, 4.9, 7.2, 12.6, 16.8, 9.4])
addSeries('REDIS-PAY-01', 'SVC-PAYMENT-GATEWAY', 'redis_memory_utilization', 'percent', 75, 90, [61, 63, 65, 67, 70, 73, 78, 77])
addSeries('REDIS-PAY-01', 'SVC-PAYMENT-GATEWAY', 'redis_connected_clients_utilization', 'percent', 70, 85, [42, 45, 49, 53, 58, 64, 71, 68])
addSeries('REDIS-PAY-01', 'SVC-PAYMENT-GATEWAY', 'redis_evictions_per_minute', 'count/min', 1, 20, [0, 0, 0, 0, 0, 2, 7, 3])
addSeries('DB-PAY-ORDERS', 'SVC-PAYMENT-GATEWAY', 'database_storage_utilization', 'percent', 75, 90, [76.8, 77.1, 77.3, 77.6, 77.9, 78.1, 78.4, 78.6])
addSeries('DB-PAY-ORDERS', 'SVC-PAYMENT-GATEWAY', 'database_connections_utilization', 'percent', 70, 85, [49, 52, 55, 59, 62, 66, 72, 69])
addSeries('DB-PAY-ORDERS', 'SVC-PAYMENT-GATEWAY', 'database_query_p95_ms', 'ms', 120, 300, [48, 51, 55, 62, 71, 86, 104, 92])
addSeries('DBNODE-PAY-02', 'SVC-PAYMENT-GATEWAY', 'database_replication_lag_ms', 'ms', 500, 2000, [42, 48, 55, 61, 84, 122, 580, 310])
addSeries('MQ-PAY-EVENTS', 'SVC-PAYMENT-GATEWAY', 'kafka_cluster_storage_utilization', 'percent', 75, 90, [63, 64, 65, 66, 67, 68, 69, 70])
addSeries('KAFKA-PAY-02', 'SVC-PAYMENT-GATEWAY', 'kafka_consumer_lag', 'messages', 10000, 50000, [1200, 1800, 2500, 3900, 6200, 9400, 12840, 11620])
addSeries('FW-CORE-02', 'SVC-NETWORK-SECURITY', 'firewall_session_table_utilization', 'percent', 70, 85, [58, 60, 61, 64, 68, 72, 76, 74])
addSeries('FW-CORE-02', 'SVC-NETWORK-SECURITY', 'ha_policy_sync_delay_ms', 'ms', 500, 1500, [84, 92, 108, 114, 136, 620, 884, 710])
addSeries('APP-FRAUD-SCORING', 'SVC-FRAUD-SCORING', 'fraud_score_p95_ms', 'ms', 180, 300, [122, 126, 131, 145, 168, 192, 224, 218])
addSeries('APP-FRAUD-SCORING', 'SVC-FRAUD-SCORING', 'fraud_score_error_rate', 'percent', 0.3, 1.0, [0.08, 0.09, 0.11, 0.14, 0.19, 0.28, 0.42, 0.37])

const documents = {
  'bankops-changes-v1': changes,
  'bankops-cmdb-cis-v1': cis,
  'bankops-cmdb-relations-v1': relations,
  'bankops-alerts-v1': alerts,
  'bankops-incidents-v1': incidents,
  'bankops-performance-v1': perf,
  'bankops-kb-documents-v1': [],
  'bankops-kb-chunks-v1': [],
  'bankops-agent-memories-v1': [],
}

async function request(path, options = {}) {
  const response = await fetch(`${esUrl}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers ?? {}) } })
  if (!response.ok && response.status !== 404) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response
}

async function waitForElasticsearch() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${esUrl}/_cluster/health?wait_for_status=yellow&timeout=2s`)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('Elasticsearch was not ready within 180 seconds')
}

await waitForElasticsearch()
for (const [index, definition] of Object.entries(indices)) {
  const isPlatformIndex = platformIndices.has(index)
  if (platformOnly && !isPlatformIndex) continue
  if (isPlatformIndex) {
    const existing = await fetch(`${esUrl}/${index}`, { method: 'HEAD' })
    if (existing.ok) {
      console.log(`${index}: retained existing platform index`)
      continue
    }
    if (existing.status !== 404) throw new Error(`HEAD ${index}: ${existing.status} ${await existing.text()}`)
  } else {
    await request(`/${index}`, { method: 'DELETE' })
  }
  await request(`/${index}`, { method: 'PUT', body: JSON.stringify({ settings: { number_of_shards: 1, number_of_replicas: 0 }, ...definition }) })
  if (documents[index].length === 0) {
    console.log(`${index}: created empty index`)
    continue
  }
  const lines = documents[index].flatMap(({ _id, ...source }) => [JSON.stringify({ index: { _index: index, _id } }), JSON.stringify(source)])
  const response = await fetch(`${esUrl}/_bulk?refresh=true`, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body: `${lines.join('\n')}\n` })
  if (!response.ok) throw new Error(`bulk ${index}: ${response.status} ${await response.text()}`)
  const result = await response.json()
  if (result.errors) throw new Error(`bulk ${index} contained document errors: ${JSON.stringify(result.items.filter(item => item.index?.error))}`)
  console.log(`${index}: seeded ${documents[index].length} documents`)
}
