/**
 * scan_config 集成测试（设计 §7.1 规则 + §11.2）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { discoverConfigFiles } from '../src/config/discover.ts'
import { parseJsonSafe, parseYamlSafe } from '../src/config/parse-safe.ts'
import { scanConfig } from '../src/config/checks.ts'
import { AuditArgsError } from '../src/runner.ts'
import type { AuditContext } from '../src/types.ts'
import { Redactor } from '../src/redact.ts'
import { cleanupTmp, findingCodes, runOnSafe, safeHome, tmpHome } from './helpers.ts'

function makeCtx(root: string, overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    action: 'scan_config',
    root,
    fixedRoot: root,
    home: process.env.USERPROFILE ?? '/home/test',
    strict: false,
    detail: true,
    includeSourceScan: false,
    signal: new AbortController().signal,
    env: { ...process.env },
    allowedRoots: [],
    allowedEndpoints: [],
    deadline: Number.POSITIVE_INFINITY,
    platform: process.platform,
    redactor: new Redactor(),
    ...overrides,
  }
}

describe('config: discovery', () => {
  it('finds .env/settings/credentials/package/patch by existence', async () => {
    const d = await discoverConfigFiles(safeHome, { deadline: Number.POSITIVE_INFINITY })
    const rels = d.files.map((f) => f.rel).sort()
    expect(rels).toContain('.env')
    expect(rels).toContain('settings.yaml')
    expect(rels).toContain('credentials.yaml')
    expect(rels).toContain('profiles/web/package.json')
    expect(rels).toContain('profiles/web/cordis.patch.yml')
    expect(d.truncated).toBe(false)
  })

  it('respects the profile filter', async () => {
    const d = await discoverConfigFiles(safeHome, { profile: 'web', deadline: Number.POSITIVE_INFINITY })
    expect(d.files.some((f) => f.rel.startsWith('profiles/web/'))).toBe(true)
    expect(d.files.some((f) => f.rel.startsWith('profiles/other/'))).toBe(false)
  })
})

describe('config: safe parsing', () => {
  it('parses nested YAML into a flat dotted map with lists', () => {
    const r = parseYamlSafe('server:\n  host: 127.0.0.1\n  port: 3080\ncors:\n  origins:\n    - http://localhost:5173\n')
    expect(r.ok).toBe(true)
    expect(r.data!['server.host']).toBe('127.0.0.1')
    expect(r.data!['server.port']).toBe(3080)
    expect(r.data!['cors.origins']).toEqual(['http://localhost:5173'])
  })

  it('rejects unsafe YAML constructs (!! tags)', () => {
    const r = parseYamlSafe('api_key: !!js/function "x"\n')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('unsafe')
  })

  it('rejects list-of-map items conservatively', () => {
    const r = parseYamlSafe('- insert:\n    - id: x\n')
    expect(r.ok).toBe(false)
  })

  it('parses JSON', () => {
    const r = parseJsonSafe('{"a": {"b": 1}}')
    expect(r.ok).toBe(true)
    expect(r.data!['a.b']).toBe(1)
    const bad = parseJsonSafe('{nope')
    expect(bad.ok).toBe(false)
  })
})

describe('config: scanConfig on safe fixture', () => {
  it('produces no secret findings and passes env expansion', async () => {
    const ctx = makeCtx(safeHome)
    const result = await scanConfig(ctx)
    const codes = findingCodes({ findings: result.findings })
    expect(codes).not.toContain('secret-in-settings')
    expect(codes).not.toContain('inline-private-key')
    expect(codes).not.toContain('env-expansion-missing')
    const secretChecks = result.checks.filter((c) => c.code === 'secret-in-settings')
    expect(secretChecks.every((c) => c.state === 'pass')).toBe(true)
  })

  it('skips credential-file-permissions on win32 (platform), not pass', async () => {
    const ctx = makeCtx(safeHome, { platform: 'win32' })
    const result = await scanConfig(ctx)
    const perm = result.checks.filter((c) => c.code === 'credential-file-permissions')
    expect(perm.length).toBeGreaterThan(0)
    expect(perm.every((c) => c.state === 'skipped' && c.skipReason === 'platform')).toBe(true)
  })
})

describe('config: scanConfig on risky fixture', () => {
  it('flags secret-in-settings for the .env api key', async () => {
    const { riskyHome } = await import('./helpers.ts')
    const result = await scanConfig(makeCtx(riskyHome))
    const codes = new Set(result.findings.map((f) => f.code))
    expect(codes.has('secret-in-settings')).toBe(true)
    expect(codes.has('external-credential-target')).toBe(true)
    expect(codes.has('plaintext-external-endpoint')).toBe(true)
    expect(codes.has('profile-path-outside-root')).toBe(true)
  })

  it('never leaks the full secret value in findings', async () => {
    const { riskyHome } = await import('./helpers.ts')
    const result = await scanConfig(makeCtx(riskyHome))
    const json = JSON.stringify(result)
    expect(json).not.toContain('sk-live-fake-not-a-real-key')
  })
})

describe('config: env expansion and unknown format', () => {
  it('flags missing ${VAR} expansions referenced by config', async () => {
    const root = await tmpHome({
      'settings.yaml': 'model:\n  discovery: http://localhost:3080\n  api_key: ${DSH_MISSING_VAR}\n',
    })
    const ctx = makeCtx(root, { env: {} })
    const result = await scanConfig(ctx)
    const codes = findingCodes({ findings: result.findings })
    expect(codes).toContain('env-expansion-missing')
    const subj = result.findings.filter((f) => f.code === 'env-expansion-missing').map((f) => f.subject)
    expect(subj).toContain('env:DSH_MISSING_VAR')
    await cleanupTmp()
  })

  it('marks unparseable config as unknown-config-format but still line-scans', async () => {
    const root = await tmpHome({
      'settings.yaml': '!!js/function()\nplain: text\napi_key = sk-live-fake-not-a-real-key-0123456789abcdef\n',
    })
    const ctx = makeCtx(root)
    const result = await scanConfig(ctx)
    const codes = new Set(result.findings.map((f) => f.code))
    expect(codes.has('unknown-config-format')).toBe(true)
    expect(codes.has('secret-in-settings')).toBe(true)
    await cleanupTmp()
  })
})

describe('config: root containment', () => {
  it('rejects a root that is neither the fixed root nor an allowed root', async () => {
    const root = await tmpHome({ 'x.yaml': 'a: 1' })
    await expect(
      runOnSafe({ action: 'scan_config', root }, { allowedRoots: [] }),
    ).rejects.toBeInstanceOf(AuditArgsError)
    await cleanupTmp()
  })

  it('accepts a root listed in allowedRoots', async () => {
    const root = await tmpHome({ 'x.yaml': 'a: 1' })
    const report = await runOnSafe({ action: 'scan_config', root }, { allowedRoots: [root] })
    expect(report.tool).toBe('security_audit')
    await cleanupTmp()
  })
})

afterAll(async () => {
  await cleanupTmp()
})
