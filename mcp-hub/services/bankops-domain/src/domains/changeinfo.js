import * as z from 'zod/v4'
import { errorResult, esGet, esSearch, jsonResult, sources } from '../es.js'

export function registerChangeInfo(server) {
  server.registerTool('get_change', {
    description: '按变更单号获取生产变更的主信息、目标配置项、实施窗口、步骤、验证与回退方案。进行影响分析时必须首先调用。',
    inputSchema: z.object({ change_id: z.string().min(1).describe('变更单号，例如 CHG20260814001') }),
  }, async ({ change_id }) => {
    try {
      const change = await esGet('bankops-changes-v1', change_id)
      return jsonResult(change ? { found: true, change } : { found: false, change_id })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('find_similar_changes', {
    description: '按系统和变更类型查询历史相似变更，用于核对成功率、回退和历史故障。',
    inputSchema: z.object({
      service_id: z.string().min(1),
      change_type: z.enum(['application_release', 'firewall_rule']),
      exclude_change_id: z.string().optional(),
      limit: z.number().int().min(1).max(20).default(5),
    }),
  }, async ({ service_id, change_type, exclude_change_id, limit }) => {
    try {
      const must = [{ term: { service_ids: service_id } }, { term: { change_type } }]
      const must_not = exclude_change_id ? [{ term: { change_id: exclude_change_id } }] : []
      const result = await esSearch('bankops-changes-v1', {
        size: limit,
        sort: [{ planned_start: 'desc' }],
        query: { bool: { must, must_not } },
      })
      return jsonResult({ service_id, change_type, changes: sources(result) })
    } catch (error) { return errorResult(error) }
  })
}
