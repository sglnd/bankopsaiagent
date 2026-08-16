import * as z from 'zod/v4'
import { errorResult, esSearch, jsonResult, sources, timeRange } from '../es.js'

export function registerPerfInfo(server) {
  server.registerTool('query_performance', {
    description: '查询指定 CI 在时间窗口内的性能指标采样值、单位、阈值和采集质量。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(50).describe('需要查询指标的 CI 标识，最多 50 个'),
      metric_names: z.array(z.string()).min(1).max(30).describe('指标名称；应先通过 list_available_metrics 获取'),
      start_time: z.string().datetime({ offset: true }).optional().describe('采样开始时间，ISO 8601 且必须包含时区'),
      end_time: z.string().datetime({ offset: true }).optional().describe('采样结束时间，ISO 8601 且必须包含时区'),
      limit: z.number().int().min(1).max(500).default(200).describe('最多返回的采样点数量'),
    }),
  }, async ({ ci_ids, metric_names, start_time, end_time, limit }) => {
    try {
      const filter = [
        { terms: { ci_id: ci_ids } },
        { terms: { metric_name: metric_names } },
        ...timeRange(start_time, end_time),
      ]
      const result = await esSearch('bankops-performance-v1', {
        size: limit, sort: [{ '@timestamp': 'asc' }], query: { bool: { filter } },
      })
      return jsonResult({ criteria: { ci_ids, metric_names, start_time, end_time }, samples: sources(result) })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('get_performance_summary', {
    description: '汇总指标的最小、最大、平均、P95、阈值越界次数和最近值，用于识别容量与性能风险。',
    inputSchema: z.object({
      ci_ids: z.array(z.string()).min(1).max(50).describe('需要汇总指标的 CI 标识，最多 50 个'),
      metric_names: z.array(z.string()).min(1).max(30).describe('指标名称；应先通过 list_available_metrics 获取'),
      start_time: z.string().datetime({ offset: true }).optional().describe('汇总开始时间，ISO 8601 且必须包含时区'),
      end_time: z.string().datetime({ offset: true }).optional().describe('汇总结束时间，ISO 8601 且必须包含时区'),
    }),
  }, async ({ ci_ids, metric_names, start_time, end_time }) => {
    try {
      const filter = [
        { terms: { ci_id: ci_ids } },
        { terms: { metric_name: metric_names } },
        ...timeRange(start_time, end_time),
      ]
      const result = await esSearch('bankops-performance-v1', {
        size: 0, query: { bool: { filter } },
        aggs: { metrics: { terms: { field: 'metric_name', size: 50 }, aggs: {
          stats: { extended_stats: { field: 'value' } },
          percentiles: { percentiles: { field: 'value', percents: [95] } },
          breaches: { filter: { term: { threshold_breached: true } } },
          latest: { top_hits: { size: 1, sort: [{ '@timestamp': 'desc' }] } },
        } } },
      })
      const metrics = result.aggregations.metrics.buckets.map(bucket => ({
        metric_name: bucket.key, samples: bucket.doc_count,
        min: bucket.stats.min, max: bucket.stats.max, avg: bucket.stats.avg,
        p95: bucket.percentiles.values['95.0'], threshold_breaches: bucket.breaches.doc_count,
        latest: bucket.latest.hits.hits[0]?._source,
      }))
      return jsonResult({ criteria: { ci_ids, metric_names, start_time, end_time }, metrics })
    } catch (error) { return errorResult(error) }
  })

  server.registerTool('list_available_metrics', {
    description: '列出目标 CI 实际可用的指标名和单位，避免模型猜测不存在的指标。',
    inputSchema: z.object({ ci_ids: z.array(z.string()).min(1).max(50).describe('需要发现可用指标的 CI 标识，最多 50 个') }),
  }, async ({ ci_ids }) => {
    try {
      const result = await esSearch('bankops-performance-v1', {
        size: 0, query: { terms: { ci_id: ci_ids } },
        aggs: { names: { composite: { size: 100, sources: [
          { metric_name: { terms: { field: 'metric_name' } } },
          { unit: { terms: { field: 'unit' } } },
        ] } } },
      })
      return jsonResult({ ci_ids, metrics: result.aggregations.names.buckets.map(item => ({ ...item.key, samples: item.doc_count })) })
    } catch (error) { return errorResult(error) }
  })
}
