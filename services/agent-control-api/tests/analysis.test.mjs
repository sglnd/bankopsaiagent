import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAnalysisPrompt, parseAgentResult, validateCreateInput } from '../analysis.mjs'

const completeResult = {
  riskLevel: 'HIGH',
  summary: 'A production dependency is at risk.',
  directImpacts: [],
  indirectImpacts: [],
  recentAlerts: [],
  performanceFindings: [],
  historicalFindings: [],
  risks: [],
  dataGaps: [],
  recommendations: [],
  evidence: [],
}

test('validates the public create contract', () => {
  assert.deepEqual(validateCreateInput({ changeId: 'CHG-APP-0001' }), {
    changeId: 'CHG-APP-0001',
    changeType: 'AUTO',
    requestedBy: 'api',
  })
  assert.throws(() => validateCreateInput({ changeId: '../bad' }), /changeId/)
  assert.throws(() => validateCreateInput({ changeId: 'CHG-1', changeType: 'OTHER' }), /changeType/)
})

test('builds a constrained Skill prompt', () => {
  const prompt = buildAnalysisPrompt({
    analysisId: 'cia_00000000-0000-0000-0000-000000000000',
    changeId: 'CHG-APP-0001',
    changeType: 'APPLICATION_RELEASE',
  })
  assert.match(prompt, /change-impact-analysis Skill/)
  assert.match(prompt, /不得虚构数据/)
  assert.match(prompt, /只输出一个.*JSON/)
})

test('extracts and normalizes a fenced JSON result', () => {
  const parsed = parseAgentResult(`result:\n\`\`\`json\n${JSON.stringify(completeResult)}\n\`\`\``, {
    analysisId: 'cia_test',
    changeId: 'CHG-APP-0001',
  })
  assert.equal(parsed.schemaVersion, '1.0')
  assert.equal(parsed.analysisId, 'cia_test')
  assert.equal(parsed.changeId, 'CHG-APP-0001')
  assert.equal(parsed.riskLevel, 'HIGH')
})

test('rejects incomplete agent output', () => {
  assert.throws(
    () => parseAgentResult('{"riskLevel":"LOW","summary":"ok"}', {
      analysisId: 'cia_test', changeId: 'CHG-1',
    }),
    /must be an array/,
  )
})
