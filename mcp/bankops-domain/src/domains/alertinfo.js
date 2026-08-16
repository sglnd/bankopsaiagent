import * as z from 'zod/v4'
import { errorResult, esSearch, jsonResult, sources, timeRange } from '../es.js'

const severity = z.enum(['critical', 'high', 'medium', 'low', 'info'])

export function registerAlertInfo(server) {
  server.registerTool('search_alerts', {
    description: '按 CI 和时间窗口查询告警、日志异常及其处置状态。无结果不能解释为系统正常。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(50).describe('需要查询告警的 CI 标识，最多 50 个'),
      start_time: z.string().datetime({ offset: true }).optional().describe('查询开始时间，ISO 8601 且必须包含时区'),
      end_time: z.string().datetime({ offset: true }).optional().describe('查询结束时间，ISO 8601 且必须包含时区'),
      severities: z.array(severity).optional().describe('可选的告警严重度过滤条件'),
      limit: z.number().int().min(1).max(100).default(50).describe('最多返回的告警明细数量'),
    }),
  }, async ({ ci_ids, start_time, end_time, severities, limit }) => {
    try {
      const filter = [{ terms: { ci_id: ci_ids } }, ...timeRange(start_time, end_time)]
      if (severities?.length) filter.push({ terms: { severity: severities } })
      const result = await esSearch('bankops-alerts-v1', { size: limit, sort: [{ '@timestamp': 'desc' }], query: { bool: { filter } } })
      return jsonResult({ criteria: { ci_ids, start_time, end_time, severities }, alerts: sources(result) })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('summarize_alerts', {
    description: '汇总指定 CI 和时间窗口内的告警数量、严重度、类型和未关闭告警，适合风险报告引用。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(50).describe('需要汇总告警的 CI 标识，最多 50 个'),
      start_time: z.string().datetime({ offset: true }).optional().describe('汇总开始时间，ISO 8601 且必须包含时区'),
      end_time: z.string().datetime({ offset: true }).optional().describe('汇总结束时间，ISO 8601 且必须包含时区'),
    }),
  }, async ({ ci_ids, start_time, end_time }) => {
    try {
      const filter = [{ terms: { ci_id: ci_ids } }, ...timeRange(start_time, end_time)]
      const result = await esSearch('bankops-alerts-v1', {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          by_severity: { terms: { field: 'severity' } },
          by_type: { terms: { field: 'event_type' } },
          by_status: { terms: { field: 'status' } },
          latest: { top_hits: { size: 5, sort: [{ '@timestamp': 'desc' }] } },
        },
      })
      return jsonResult({
        criteria: { ci_ids, start_time, end_time }, total: result.hits.total.value,
        by_severity: result.aggregations.by_severity.buckets,
        by_type: result.aggregations.by_type.buckets,
        by_status: result.aggregations.by_status.buckets,
        latest: result.aggregations.latest.hits.hits.map(hit => hit._source),
      })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('find_related_incidents', {
    description: '查询与目标 CI 相关的历史生产事件、根因、恢复耗时和改进措施。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(50).describe('用于匹配历史事件影响范围的 CI 标识'),
      limit: z.number().int().min(1).max(20).default(10).describe('最多返回的历史事件数量'),
    }),
  }, async ({ ci_ids, limit }) => {
    try {
      const result = await esSearch('bankops-incidents-v1', {
        size: limit, sort: [{ started_at: 'desc' }], query: { terms: { affected_ci_ids: ci_ids } },
      })
      return jsonResult({ ci_ids, incidents: sources(result) })
    } catch (error) { return errorResult(error) }
  })
}
