import { spawn } from 'node:child_process'

export const CHANGE_TYPES = new Set(['AUTO', 'APPLICATION_RELEASE', 'FIREWALL_RULE'])
export const RISK_LEVELS = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNDETERMINED'])

export function validateCreateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('request body must be a JSON object')
  }

  const changeId = typeof value.changeId === 'string' ? value.changeId.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(changeId)) {
    throw new TypeError('changeId must be 3-64 letters, digits, dots, underscores, or hyphens')
  }

  const changeType = value.changeType ?? 'AUTO'
  if (!CHANGE_TYPES.has(changeType)) {
    throw new TypeError('changeType must be AUTO, APPLICATION_RELEASE, or FIREWALL_RULE')
  }

  const requestedBy = value.requestedBy ?? 'api'
  if (typeof requestedBy !== 'string' || requestedBy.trim().length < 1 || requestedBy.length > 128) {
    throw new TypeError('requestedBy must be a non-empty string of at most 128 characters')
  }

  return { changeId, changeType, requestedBy: requestedBy.trim() }
}

export function buildAnalysisPrompt({ analysisId, changeId, changeType }) {
  return `使用 change-impact-analysis Skill 对变更单 ${changeId} 执行完整的变更影响分析。

调用约束：
1. 必须先查询 ChangeInfo MCP，再根据返回的真实 CI 调用 CMDB、AlertInfo 和 PerfInfo MCP。
2. 变更类型提示为 ${changeType}；以 ChangeInfo MCP 返回的事实为准，冲突时明确披露。
3. 不得虚构数据。工具失败或数据缺失时，riskLevel 必须按 Skill 规则处理。
4. 不要输出 Markdown、代码围栏、解释性前言或尾注。
5. 最终只输出一个符合下列结构的 JSON 对象：

{
  "schemaVersion": "1.0",
  "analysisId": "${analysisId}",
  "changeId": "${changeId}",
  "riskLevel": "HIGH | MEDIUM | LOW | UNDETERMINED",
  "riskScore": 0,
  "summary": "结论摘要",
  "changeOverview": {},
  "directImpacts": [],
  "indirectImpacts": [],
  "recentAlerts": [],
  "performanceFindings": [],
  "historicalFindings": [],
  "risks": [{"code":"","severity":"HIGH | MEDIUM | LOW","description":"","evidenceRefs":[]}],
  "dataGaps": [],
  "recommendations": [],
  "evidence": [{"id":"","source":"changeinfo | cmdb | alertinfo | perfinfo","tool":"","fact":{}}]
}`
}

export function parseAgentResult(output, expected) {
  const text = String(output ?? '').trim()
  const candidates = [text]
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced) candidates.push(fenced[1].trim())
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1))

  let parsed
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate)
      break
    } catch {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('agent did not return a JSON object')
  }
  if (!RISK_LEVELS.has(parsed.riskLevel)) {
    throw new Error('agent result has an invalid riskLevel')
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') {
    throw new Error('agent result is missing summary')
  }

  const arrays = [
    'directImpacts', 'indirectImpacts', 'recentAlerts', 'performanceFindings',
    'historicalFindings', 'risks', 'dataGaps', 'recommendations', 'evidence',
  ]
  for (const field of arrays) {
    if (!Array.isArray(parsed[field])) throw new Error(`agent result field ${field} must be an array`)
  }

  return {
    ...parsed,
    schemaVersion: '1.0',
    analysisId: expected.analysisId,
    changeId: expected.changeId,
  }
}

export async function runHeadlessAnalysis(task, options = {}) {
  if (options.mode === 'mock') {
    await new Promise(resolve => setTimeout(resolve, options.mockDelayMs ?? 25))
    return {
      schemaVersion: '1.0',
      analysisId: task.id,
      changeId: task.changeId,
      riskLevel: 'UNDETERMINED',
      riskScore: 0,
      summary: 'Mock runner completed; no production systems were queried.',
      changeOverview: { changeType: task.changeType, mode: 'mock' },
      directImpacts: [],
      indirectImpacts: [],
      recentAlerts: [],
      performanceFindings: [],
      historicalFindings: [],
      risks: [],
      dataGaps: ['Mock runner does not query MCP services.'],
      recommendations: [],
      evidence: [],
    }
  }

  const prompt = buildAnalysisPrompt({
    analysisId: task.id,
    changeId: task.changeId,
    changeType: task.changeType,
  })
  return runHeadlessPrompt(prompt, output => parseAgentResult(output, {
    analysisId: task.id,
    changeId: task.changeId,
  }), options)
}

export async function runHeadlessPrompt(prompt, parseOutput, options = {}) {
  const executable = options.executable ?? 'dsh'
  const timeoutMs = options.timeoutMs ?? 300_000
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--profile', 'headless', prompt], {
      cwd: options.cwd ?? '/workspace',
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    options.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    let outputTooLarge = false
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)

    child.stdout.on('data', chunk => {
      if (Buffer.byteLength(stdout) + chunk.length > maxOutputBytes) {
        outputTooLarge = true
        child.kill('SIGTERM')
        return
      }
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      if (Buffer.byteLength(stderr) < 512 * 1024) stderr += chunk
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (outputTooLarge) return reject(new Error('agent output exceeded the configured limit'))
      if (code !== 0) {
        const detail = stderr.trim().slice(-4000)
        return reject(new Error(`headless Harness exited with ${code ?? signal}: ${detail}`))
      }
      try {
        resolve(parseOutput(stdout))
      } catch (error) {
        reject(new Error(`${error.message}; output=${stdout.trim().slice(0, 4000)}`))
      }
    })
  })
}
