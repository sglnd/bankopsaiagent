import { runHeadlessPrompt } from './analysis.mjs'

export const HEALTH_STATUSES = new Set(['CRITICAL', 'WARNING', 'HEALTHY', 'UNDETERMINED'])

export function validateInspectionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('request body must be a JSON object')
  }
  const serviceId = typeof value.serviceId === 'string' ? value.serviceId.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(serviceId)) {
    throw new TypeError('serviceId must be 3-64 letters, digits, dots, underscores, or hyphens')
  }
  const environment = value.environment ?? 'production'
  if (typeof environment !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(environment)) {
    throw new TypeError('environment must be 2-32 letters, digits, dots, underscores, or hyphens')
  }
  const requestedBy = value.requestedBy ?? 'api'
  if (typeof requestedBy !== 'string' || requestedBy.trim().length < 1 || requestedBy.length > 128) {
    throw new TypeError('requestedBy must be a non-empty string of at most 128 characters')
  }
  const alertLookbackHours = value.alertLookbackHours ?? 168
  const metricLookbackHours = value.metricLookbackHours ?? 24
  if (!Number.isInteger(alertLookbackHours) || alertLookbackHours < 1 || alertLookbackHours > 720) {
    throw new TypeError('alertLookbackHours must be an integer between 1 and 720')
  }
  if (!Number.isInteger(metricLookbackHours) || metricLookbackHours < 1 || metricLookbackHours > 168) {
    throw new TypeError('metricLookbackHours must be an integer between 1 and 168')
  }
  return {
    serviceId,
    environment,
    requestedBy: requestedBy.trim(),
    alertLookbackHours,
    metricLookbackHours,
  }
}

export function buildInspectionPrompt({ inspectionId, serviceId, environment, alertLookbackHours, metricLookbackHours }) {
  return `使用 inspect-application-system Skill 对应用系统 ${serviceId} 执行完整系统巡检。

调用约束：
1. 必须先调用 CMDB get_service_inventory，environment=${environment}，并使用返回的真实 CI 范围。
2. 对全部内部 CI 调用 PerfInfo list_available_metrics 后，才能查询实际存在的性能和容量指标。
3. 告警分析窗口为最近 ${alertLookbackHours} 小时；性能和容量窗口为最近 ${metricLookbackHours} 小时。
4. 必须调用 AlertInfo 和 PerfInfo；不得虚构资产、IP、指标、阈值、告警或事件。
5. 关键资产监控缺失时必须写入 dataGaps，不能将缺失解释为健康。
6. 不要输出 Markdown、代码围栏、解释性前言或尾注。
7. 最终只输出一个符合下列结构的 JSON 对象：

{
  "schemaVersion": "1.0",
  "inspectionId": "${inspectionId}",
  "serviceId": "${serviceId}",
  "healthStatus": "CRITICAL | WARNING | HEALTHY | UNDETERMINED",
  "healthScore": 0,
  "summary": "结论摘要",
  "systemOverview": {},
  "inventorySummary": {},
  "applicationModules": [],
  "ipNodes": [],
  "middleware": [],
  "databases": [],
  "networkComponents": [],
  "activeAlerts": [],
  "performanceFindings": [],
  "capacityFindings": [],
  "topologyRisks": [],
  "historicalIncidents": [],
  "risks": [{"code":"","severity":"CRITICAL | HIGH | MEDIUM | LOW","description":"","evidenceRefs":[]}],
  "dataGaps": [],
  "recommendations": [],
  "evidence": [{"id":"","source":"cmdb | alertinfo | perfinfo","tool":"","ciIds":[],"fact":{}}]
}`
}

export function parseInspectionResult(output, expected) {
  const text = String(output ?? '').trim()
  const candidates = [text]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1].trim())
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  let parsed
  for (const candidate of candidates) {
    try { parsed = JSON.parse(candidate); break } catch {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent did not return a JSON object')
  }
  if (!HEALTH_STATUSES.has(parsed.healthStatus)) throw new Error('agent result has an invalid healthStatus')
  if (!Number.isInteger(parsed.healthScore) || parsed.healthScore < 0 || parsed.healthScore > 100) {
    throw new Error('agent result has an invalid healthScore')
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    throw new Error('agent result is missing summary')
  }
  for (const field of [
    'applicationModules', 'ipNodes', 'middleware', 'databases', 'networkComponents',
    'activeAlerts', 'performanceFindings', 'capacityFindings', 'topologyRisks',
    'historicalIncidents', 'risks', 'dataGaps', 'recommendations', 'evidence',
  ]) {
    if (!Array.isArray(parsed[field])) throw new Error(`agent result field ${field} must be an array`)
  }
  return { ...parsed, schemaVersion: '1.0', inspectionId: expected.inspectionId, serviceId: expected.serviceId }
}

export async function runSystemInspection(task, options = {}) {
  if (options.mode === 'mock') {
    await new Promise(resolve => setTimeout(resolve, options.mockDelayMs ?? 25))
    return {
      schemaVersion: '1.0', inspectionId: task.id, serviceId: task.serviceId,
      healthStatus: 'UNDETERMINED', healthScore: 0,
      summary: 'Mock runner completed; no production systems were queried.',
      systemOverview: { environment: task.environment, mode: 'mock' }, inventorySummary: {},
      applicationModules: [], ipNodes: [], middleware: [], databases: [], networkComponents: [],
      activeAlerts: [], performanceFindings: [], capacityFindings: [], topologyRisks: [],
      historicalIncidents: [], risks: [], dataGaps: ['Mock runner does not query MCP services.'],
      recommendations: [], evidence: [],
    }
  }
  const prompt = buildInspectionPrompt({
    inspectionId: task.id,
    serviceId: task.serviceId,
    environment: task.environment,
    alertLookbackHours: task.alertLookbackHours,
    metricLookbackHours: task.metricLookbackHours,
  })
  return runHeadlessPrompt(prompt, output => parseInspectionResult(output, {
    inspectionId: task.id,
    serviceId: task.serviceId,
  }), options)
}
