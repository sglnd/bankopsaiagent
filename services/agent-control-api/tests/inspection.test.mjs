import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildInspectionPrompt, parseInspectionResult, validateInspectionInput } from '../inspection.mjs'

const completeResult = {
  healthStatus: 'WARNING', healthScore: 72, summary: 'Capacity risk found.',
  systemOverview: {}, inventorySummary: {}, applicationModules: [], ipNodes: [],
  middleware: [], databases: [], networkComponents: [], activeAlerts: [],
  performanceFindings: [], capacityFindings: [], topologyRisks: [], historicalIncidents: [],
  risks: [], dataGaps: [], recommendations: [], evidence: [],
}

test('validates inspection input and defaults time windows', () => {
  assert.deepEqual(validateInspectionInput({ serviceId: 'SVC-PAYMENT-GATEWAY' }), {
    serviceId: 'SVC-PAYMENT-GATEWAY', environment: 'production', requestedBy: 'api',
    alertLookbackHours: 168, metricLookbackHours: 24,
  })
  assert.throws(() => validateInspectionInput({ serviceId: '../bad' }), /serviceId/)
  assert.throws(() => validateInspectionInput({ serviceId: 'SVC-1', metricLookbackHours: 0 }), /metricLookbackHours/)
})

test('builds a constrained inspection prompt', () => {
  const prompt = buildInspectionPrompt({
    inspectionId: 'sia_00000000-0000-0000-0000-000000000000',
    serviceId: 'SVC-PAYMENT-GATEWAY', environment: 'production',
    alertLookbackHours: 168, metricLookbackHours: 24,
  })
  assert.match(prompt, /inspect-application-system Skill/)
  assert.match(prompt, /get_service_inventory/)
  assert.match(prompt, /不得虚构资产/)
})

test('extracts and normalizes an inspection result', () => {
  const parsed = parseInspectionResult(`\`\`\`json\n${JSON.stringify(completeResult)}\n\`\`\``, {
    inspectionId: 'sia_test', serviceId: 'SVC-PAYMENT-GATEWAY',
  })
  assert.equal(parsed.inspectionId, 'sia_test')
  assert.equal(parsed.healthStatus, 'WARNING')
  assert.equal(parsed.healthScore, 72)
})

test('rejects invalid inspection output', () => {
  assert.throws(() => parseInspectionResult('{"healthStatus":"GOOD","healthScore":100,"summary":"ok"}', {
    inspectionId: 'sia_test', serviceId: 'SVC-PAYMENT-GATEWAY',
  }), /healthStatus/)
})
