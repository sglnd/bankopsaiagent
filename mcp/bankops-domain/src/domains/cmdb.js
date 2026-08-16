import * as z from 'zod/v4'
import { errorResult, esGet, esSearch, jsonResult, sources } from '../es.js'

const CI_GROUPS = {
  application: new Set(['application', 'application_module', 'kubernetes_deployment', 'application_instance']),
  compute: new Set(['host', 'virtual_machine', 'kubernetes_node']),
  database: new Set(['database', 'database_cluster', 'database_instance']),
  middleware: new Set(['redis_cluster', 'redis_node', 'message_queue', 'message_broker', 'web_container']),
  network: new Set(['load_balancer', 'firewall_cluster', 'network_path', 'switch', 'router']),
}

function groupCis(cis) {
  const grouped = Object.fromEntries(Object.keys(CI_GROUPS).map(name => [name, []]))
  grouped.other = []
  for (const ci of cis) {
    const group = Object.entries(CI_GROUPS).find(([, types]) => types.has(ci.ci_type))?.[0] ?? 'other'
    grouped[group].push(ci)
  }
  return grouped
}

export function registerCmdb(server) {
  server.registerTool('get_service_inventory', {
    description: '按 service_id 获取应用系统完整资产清单、IP、内部关系和直接外部依赖，并按应用、计算、数据库、中间件、网络分类；适用于系统巡检。',
    inputSchema: z.object({
      service_id: z.string().min(1).describe('应用系统唯一标识，例如 SVC-PAYMENT-GATEWAY'),
      environment: z.string().min(1).default('production').describe('资产所属环境，例如 production、staging'),
      include_external_dependencies: z.boolean().default(true).describe('是否包含与系统内部 CI 直接相连的外部上下游依赖'),
    }),
  }, async ({ service_id, environment, include_external_dependencies }) => {
    try {
      const internalResult = await esSearch('bankops-cmdb-cis-v1', {
        size: 500,
        query: { bool: { filter: [
          { term: { service_id } },
          { term: { environment } },
        ] } },
      })
      const internalCis = sources(internalResult)
      const internalIds = internalCis.map(ci => ci.ci_id)
      if (internalIds.length === 0) {
        return jsonResult({ found: false, service_id, environment, inventory: [], relations: [], external_dependencies: [] })
      }

      const relationResult = await esSearch('bankops-cmdb-relations-v1', {
        size: 1000,
        query: { bool: { should: [
          { terms: { source_ci_id: internalIds } },
          { terms: { target_ci_id: internalIds } },
        ], minimum_should_match: 1 } },
      })
      const relations = sources(relationResult)
      const externalIds = include_external_dependencies
        ? [...new Set(relations.flatMap(item => [item.source_ci_id, item.target_ci_id]).filter(id => !internalIds.includes(id)))]
        : []
      const externalResult = externalIds.length
        ? await esSearch('bankops-cmdb-cis-v1', { size: 200, query: { terms: { ci_id: externalIds } } })
        : { hits: { hits: [] } }
      const externalCis = sources(externalResult)

      return jsonResult({
        found: true,
        service_id,
        environment,
        summary: {
          internal_ci_count: internalCis.length,
          external_dependency_count: externalCis.length,
          relation_count: relations.length,
          by_type: Object.fromEntries(Object.entries(groupCis(internalCis)).map(([name, items]) => [name, items.length])),
        },
        inventory: internalCis,
        groups: groupCis(internalCis),
        relations,
        external_dependencies: externalCis,
      })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('get_ci', {
    description: '按 CI 标识获取应用、服务、主机、数据库、负载均衡、网络设备或安全域配置项。',
    inputSchema: z.object({ ci_id: z.string().min(1).describe('CMDB 配置项唯一标识') }),
  }, async ({ ci_id }) => {
    try {
      const ci = await esGet('bankops-cmdb-cis-v1', ci_id)
      return jsonResult(ci ? { found: true, ci } : { found: false, ci_id })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('get_topology', {
    description: '获取一组目标 CI 的上下游、部署、数据访问和网络依赖关系；返回关系两端的完整 CI 摘要。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(30).describe('拓扑遍历的起始 CI 标识，最多 30 个'),
      depth: z.number().int().min(1).max(3).default(2).describe('上下游关系遍历深度，范围 1-3'),
    }),
  }, async ({ ci_ids, depth }) => {
    try {
      const visited = new Set(ci_ids)
      let frontier = [...ci_ids]
      const relations = []
      for (let level = 1; level <= depth && frontier.length; level += 1) {
        const result = await esSearch('bankops-cmdb-relations-v1', {
          size: 200,
          query: { bool: { should: [
            { terms: { source_ci_id: frontier } },
            { terms: { target_ci_id: frontier } },
          ], minimum_should_match: 1 } },
        })
        const next = []
        for (const relation of sources(result)) {
          if (!relations.some(item => item.relation_id === relation.relation_id)) relations.push({ ...relation, depth: level })
          for (const id of [relation.source_ci_id, relation.target_ci_id]) {
            if (!visited.has(id)) { visited.add(id); next.push(id) }
          }
        }
        frontier = next
      }
      const cisResult = await esSearch('bankops-cmdb-cis-v1', { size: 200, query: { terms: { ci_id: [...visited] } } })
      return jsonResult({ roots: ci_ids, depth, cis: sources(cisResult), relations })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('find_network_path', {
    description: '查询源 CI 到目标 CI 的已登记网络路径、协议、端口、防火墙策略和安全域，适用于防火墙开通变更。',
    inputSchema: z.object({
      source_ci_id: z.string().min(1).describe('网络访问源 CI 标识'),
      target_ci_id: z.string().min(1).describe('网络访问目标 CI 标识'),
      protocol: z.enum(['TCP', 'UDP']).optional().describe('可选的传输层协议过滤条件'),
      port: z.number().int().min(1).max(65535).optional().describe('可选的目标端口过滤条件'),
    }),
  }, async ({ source_ci_id, target_ci_id, protocol, port }) => {
    try {
      const filters = [
        { term: { source_ci_id } },
        { term: { target_ci_id } },
        { term: { relation_type: 'network_path' } },
      ]
      if (protocol) filters.push({ term: { protocol } })
      if (port) filters.push({ term: { port } })
      const result = await esSearch('bankops-cmdb-relations-v1', { size: 20, query: { bool: { filter: filters } } })
      return jsonResult({ source_ci_id, target_ci_id, protocol, port, paths: sources(result) })
    } catch (error) { return errorResult(error) }
  })
}
