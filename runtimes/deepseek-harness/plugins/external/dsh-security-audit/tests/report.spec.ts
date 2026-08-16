/**
 * 报告模型与调度测试（设计 §5 / §9 / §11.2）。
 * 覆盖：verdict 双维度、strict、预算截断、确定性排序、AbortSignal、
 * 输出预算、canonical JSON、root containment。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import * as path from 'node:path'
import {
  AuditArgsError,
  buildReport,
  computeCoverageVerdict,
  computeRiskVerdict,
  computeVerdict,
  runAction,
  summarize,
} from '../src/runner.ts'
import { LIMITS } from '../src/limits.ts'
import { Redactor } from '../src/redact.ts'
import type { AuditContext, CheckResult, Finding } from '../src/types.ts'
import { cleanupTmp, findingCodes, runOnRisky, runOnSafe, seedFixtureNodeModules, tmpHome } from './helpers.ts'

function fakeCtx(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    action: 'scan_config',
    root: path.join(homedir(), '.dsh'),
    fixedRoot: path.join(homedir(), '.dsh'),
    home: homedir(),
    strict: false,
    detail: true,
    includeSourceScan: false,
    signal: new AbortController().signal,
    env: {},
    allowedRoots: [],
    allowedEndpoints: [],
    deadline: Number.POSITIVE_INFINITY,
    platform: 'linux',
    redactor: new Redactor(),
    ...overrides,
  }
}

function finding(severity: Finding['severity'], code = 'secret-in-settings'): Finding {
  return {
    severity,
    code,
    category: 'config',
    subject: 'x.yaml',
    exposure: 'e',
    recommendation: 'r',
    confidence: 'high',
    ruleVersion: 1,
  }
}

function check(state: CheckResult['state'], code = 'secret-in-settings', skipReason?: CheckResult['skipReason']): CheckResult {
  return { code, state, subject: 'x.yaml', severity: 'info', ...(skipReason !== undefined ? { skipReason } : {}) }
}

describe('report: verdict computation (pure)', () => {
  it('critical/high → fail', () => {
    expect(computeRiskVerdict([finding('high')], false)).toBe('fail')
    expect(computeRiskVerdict([finding('critical')], false)).toBe('fail')
  })

  it('medium → warning, or fail under strict', () => {
    expect(computeRiskVerdict([finding('medium')], false)).toBe('warning')
    expect(computeRiskVerdict([finding('medium')], true)).toBe('fail')
  })

  it('low → warning; info/pass → pass', () => {
    expect(computeRiskVerdict([finding('low')], false)).toBe('warning')
    expect(computeRiskVerdict([finding('info')], false)).toBe('pass')
    expect(computeRiskVerdict([], false)).toBe('pass')
  })

  it('coverage: critical error → incomplete; critical platform-skip → incomplete; non-critical skip → complete', () => {
    expect(computeCoverageVerdict([check('error')])).toBe('incomplete')
    expect(computeCoverageVerdict([check('skipped', 'credential-file-permissions', 'platform')])).toBe('incomplete')
    expect(computeCoverageVerdict([check('skipped', 'credential-file-permissions', 'permission')])).toBe('incomplete')
    expect(computeCoverageVerdict([check('skipped', 'install-script', 'config')])).toBe('complete')
    expect(computeCoverageVerdict([check('skipped', 'plugin-unpinned-git', 'not-applicable')])).toBe('complete')
    expect(computeCoverageVerdict([check('pass')])).toBe('complete')
  })

  it('coverage: internal scanner error → incomplete', () => {
    expect(computeCoverageVerdict([{ code: 'internal-error', state: 'error', subject: 'action:x', severity: 'info' }])).toBe('incomplete')
  })

  it('top-level verdict priority: fail > incomplete > warning > pass', () => {
    expect(computeVerdict('fail', 'incomplete')).toBe('fail')
    expect(computeVerdict('warning', 'incomplete')).toBe('incomplete')
    expect(computeVerdict('pass', 'complete')).toBe('pass')
    expect(computeVerdict('warning', 'complete')).toBe('warning')
  })

  it('summarize counts findings by severity and check states', () => {
    const s = summarize([finding('high'), finding('medium'), finding('info')], [
      check('pass'), check('pass'), check('skipped'), check('error'),
    ])
    expect(s).toMatchObject({ high: 1, medium: 1, info: 1, passed: 2, skipped: 1, errors: 1 })
  })
})

describe('report: end-to-end on fixtures', () => {
  let cleanupStubs: (() => Promise<void>) | undefined
  beforeAll(async () => { cleanupStubs = await seedFixtureNodeModules() })
  afterAll(async () => { await cleanupStubs?.() })

  it('rules action returns the rule catalog without file access', async () => {
    const out = await runAction({ action: 'rules' })
    if (!('action' in out) || out.action !== 'rules') throw new Error('expected rules output')
    const rules = out.rules
    expect(rules.length).toBeGreaterThan(20)
    const codes = new Set(rules.map((r) => r.code))
    expect(codes.has('secret-in-settings')).toBe(true)
    expect(codes.has('session-suspicious-expansion')).toBe(true)
    for (const r of rules) {
      expect(r.ruleVersion).toBeGreaterThan(0)
      expect(['critical', 'high', 'medium', 'low', 'info']).toContain(r.severity)
    }
  })

  it('safe fixture: risk passes; coverage complete when nothing critical is skipped', async () => {
    // 无 credentials / 无 sessions 的干净 home：win32 上也能得到完整覆盖
    const root = await tmpHome({
      'settings.yaml': 'server:\n  host: 127.0.0.1\n',
    })
    const report = await runAction({ action: 'report', root }, { fixedRoot: root })
    if (!('findings' in report)) throw new Error('expected report')
    expect(findingCodes(report)).toEqual([])
    expect(report.riskVerdict).toBe('pass')
    expect(report.coverageVerdict).toBe('complete')
    expect(report.verdict).toBe('pass')
    await cleanupTmp()
  })

  it('safe fixture with credentials on win32: risk pass, coverage incomplete (by design)', async () => {
    const report = await runOnSafe({ action: 'report' })
    if (!('findings' in report)) throw new Error('expected report')
    if (process.platform === 'win32') {
      expect(report.riskVerdict).toBe('pass')
      expect(report.coverageVerdict).toBe('incomplete')
      expect(report.verdict).toBe('incomplete')
    }
  })

  it('risky fixture: verdict fail with risk findings', async () => {
    const report = await runOnRisky({ action: 'report' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(report.riskVerdict).toBe('fail')
    expect(report.verdict).toBe('fail')
    expect(report.findings.length).toBeGreaterThan(0)
    // summary 与 findings 一致
    const bySeverity = report.findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1
      return acc
    }, {})
    expect(report.summary.high).toBe(bySeverity['high'] ?? 0)
  })

  it('report root is redacted to $DSH_HOME for the fixed root', async () => {
    const report = await runOnSafe({ action: 'report' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(report.root).toBe('$DSH_HOME')
  })

  it('deterministic ordering: same environment → same stable fields', async () => {
    const a = await runOnRisky({ action: 'report' })
    const b = await runOnRisky({ action: 'report' })
    if (!('findings' in a) || !('findings' in b)) throw new Error('expected report')
    const stable = (r: typeof a): unknown => ({
      codes: r.findings.map((f) => [f.severity, f.code, f.category, f.subject, f.evidence?.path, f.evidence?.line]),
      checks: r.checks.map((c) => [c.code, c.state, c.subject]),
      summary: r.summary,
      verdicts: [r.verdict, r.riskVerdict, r.coverageVerdict],
    })
    expect(stable(a)).toEqual(stable(b))
    // fingerprint 是随机 HMAC，明确排除在跨运行稳定字段之外
    const fpsA = new Set(a.findings.map((f) => f.evidence?.fingerprint).filter(Boolean))
    const fpsB = new Set(b.findings.map((f) => f.evidence?.fingerprint).filter(Boolean))
    expect(fpsA.size).toBeGreaterThan(0)
    expect([...fpsA].some((fp) => fpsB.has(fp))).toBe(false)
  })

  it('canonical JSON output round-trips', async () => {
    const report = await runOnRisky({ action: 'report' })
    if (!('findings' in report)) throw new Error('expected report')
    const text = JSON.stringify(report)
    const parsed = JSON.parse(text) as typeof report
    expect(parsed.tool).toBe('security_audit')
    expect(parsed.version).toBe(1)
  })
})

describe('report: budgets and abort', () => {
  it('findings budget truncates at LIMITS.findings', () => {
    const many: Finding[] = []
    for (let i = 0; i < LIMITS.findings + 50; i++) many.push(finding('low', 'env-expansion-missing'))
    const report = buildReport(fakeCtx(), [{ checks: [], findings: many }], false)
    expect(report.findings.length).toBe(LIMITS.findings)
    expect(report.truncated).toBe(true)
  })

  it('output budget throws when canonical JSON exceeds 2MiB', () => {
    const huge: Finding[] = [{
      ...finding('high'),
      evidence: { value: 'x'.repeat(LIMITS.outputBytes + 1024), redacted: false },
    }]
    expect(() => buildReport(fakeCtx(), [{ checks: [], findings: huge }], false)).toThrow(/output exceeds/)
  })

  it('aborted signal rejects the action (no partial report)', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runOnSafe({ action: 'report' }, { signal: controller.signal })).rejects.toThrow(/cancelled/)
  })

  it('root outside fixed/allowed roots is rejected', async () => {
    const root = await tmpHome({ 'a.yaml': 'x: 1' })
    await expect(
      runAction({ action: 'scan_config', root }, { fixedRoot: path.join(homedir(), '.dsh-nope') }),
    ).rejects.toBeInstanceOf(AuditArgsError)
    await cleanupTmp()
  })

  it('invalid profile name is rejected', async () => {
    await expect(runOnSafe({ action: 'scan_config', profile: '../etc/passwd' })).rejects.toBeInstanceOf(AuditArgsError)
  })

  it('unknown action is rejected', async () => {
    await expect(runAction({ action: 'nope' } as never)).rejects.toBeInstanceOf(AuditArgsError)
  })
})

afterAll(async () => {
  await cleanupTmp()
})
