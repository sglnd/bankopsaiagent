import * as z from 'zod/v4'
import { errorResult, esGet, esSearch, jsonResult, sources } from '../es.js'

export function registerCmdb(server) {
  server.registerTool('get_ci', {
    description: '按 CI 标识获取应用、服务、主机、数据库、负载均衡、网络设备或安全域配置项。',
    inputSchema: z.object({ ci_id: z.string().min(1) }),
  }, async ({ ci_id }) => {
    try {
      const ci = await esGet('bankops-cmdb-cis-v1', ci_id)
      return jsonResult(ci ? { found: true, ci } : { found: false, ci_id })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('get_topology', {
    description: '获取一组目标 CI 的上下游、部署、数据访问和网络依赖关系；返回关系两端的完整 CI 摘要。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(30),
      depth: z.number().int().min(1).max(3).default(2),
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
      source_ci_id: z.string().min(1),
      target_ci_id: z.string().min(1),
      protocol: z.enum(['TCP', 'UDP']).optional(),
      port: z.number().int().min(1).max(65535).optional(),
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
