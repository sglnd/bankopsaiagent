/**
 * scan_sessions 测试（设计 §7.3 + §11.2：torn/oversized/ratio fixture、
 * symlink escape、unreadable → skipped/error）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { analyzeZstd } from '../src/sessions/zstd-scan.ts'
import { discoverSessions } from '../src/sessions/discover.ts'
import { scanSessions } from '../src/sessions/checks.ts'
import type { AuditContext } from '../src/types.ts'
import { Redactor } from '../src/redact.ts'
import {
  canCreateSymlink,
  cleanupTmp,
  findingCodes,
  runOnRisky,
  runOnSafe,
  safeFrame,
  suspiciousFrame,
  tornFrame,
  oversizedFrame,
  tmpHome,
} from './helpers.ts'

function makeCtx(root: string, overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    action: 'scan_sessions',
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

const SESSION_PATH = 'sessions/--C-Users-admin-Desktop-dshext--/abc123/session.jsonl.zstd'

describe('sessions: zstd frame analysis (stage-1, header only)', () => {
  it('parses a valid frame header (FCS + no torn)', () => {
    const a = analyzeZstd(safeFrame(), safeFrame().length)
    expect(a.isZstd).toBe(true)
    expect(a.headerComplete).toBe(true)
    expect(a.torn).toBe(false)
    expect(a.fcs).toBe(10)
    expect(a.frames).toBe(1)
  })

  it('detects torn (truncated) frames', () => {
    const a = analyzeZstd(tornFrame(), tornFrame().length)
    expect(a.isZstd).toBe(true)
    expect(a.torn).toBe(true)
    expect(a.error).toBe('truncated')
  })

  it('detects oversized frame content size', () => {
    const a = analyzeZstd(oversizedFrame(), oversizedFrame().length)
    expect(a.fcs).toBeGreaterThan(16 * 1024 * 1024)
  })

  it('detects suspicious expansion ratios from metadata', () => {
    const a = analyzeZstd(suspiciousFrame(), suspiciousFrame().length)
    expect(a.fcs).toBe(2 * 1024 * 1024)
    expect(a.fcs! / a.compressedSize).toBeGreaterThan(100)
  })

  it('rejects non-zstd input', () => {
    const a = analyzeZstd(Buffer.from('not a zstd stream'), 16)
    expect(a.isZstd).toBe(false)
    expect(a.error).toBe('not-zstd')
  })
})

describe('sessions: discovery', () => {
  it('walks the two-level layout and classifies stray files', async () => {
    const root = await tmpHome({
      [SESSION_PATH]: safeFrame(),
      'sessions/stray.tmp': 'x',
    })
    const d = await discoverSessions(root, { deadline: Number.POSITIVE_INFINITY })
    expect(d.rootExists).toBe(true)
    const kinds = d.entries.map((e) => e.kind).sort()
    expect(kinds).toContain('session')
    expect(kinds).toContain('stray')
    await cleanupTmp()
  })

  it('reports missing sessions root without pretending pass', async () => {
    const root = await tmpHome({ 'settings.yaml': 'a: 1' })
    const d = await discoverSessions(root, { deadline: Number.POSITIVE_INFINITY })
    expect(d.rootExists).toBe(false)
    await cleanupTmp()
  })
})

describe('sessions: scanSessions on fixtures', () => {
  it('safe fixture: session frames pass; root permission platform-skipped on win32', async () => {
    const report = await runOnSafe({ action: 'scan_sessions' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(findingCodes(report)).toEqual([])
    const torn = report.checks.filter((c) => c.code === 'session-torn-frame')
    expect(torn.some((c) => c.state === 'pass')).toBe(true)
    const rootPerm = report.checks.filter((c) => c.code === 'session-root-permissions')
    if (process.platform === 'win32') {
      // 平台不支持 ACL 判定 → skipped（不是 pass）
      expect(rootPerm.some((c) => c.state === 'skipped' && c.skipReason === 'platform')).toBe(true)
    }
  })

  it('risky fixture: torn/oversized/suspicious/non-zstd/temp-residue findings', async () => {
    const report = await runOnRisky({ action: 'scan_sessions' })
    if (!('findings' in report)) throw new Error('expected report')
    const codes = findingCodes(report)
    expect(codes).toContain('session-torn-frame')
    expect(codes).toContain('session-oversized-frame')
    expect(codes).toContain('session-suspicious-expansion')
    expect(codes).toContain('session-non-zstd')
    expect(codes).toContain('session-temp-residue')
  })
})

describe('sessions: symlink escape', () => {
  it('flags symlinks under sessions without following them', async () => {
    if (!(await canCreateSymlink())) {
      console.warn('symlink creation unavailable; skipping symlink test')
      return
    }
    const root = await tmpHome({
      'sessions/--C-Users-admin-Desktop-dshext--/abc123/session.jsonl.zstd': safeFrame(),
    })
    const outside = await tmpHome({ 'secret.txt': 'x' })
    const link = path.join(root, 'sessions', 'escape-link')
    try {
      await fs.symlink(outside, link, 'dir')
    } catch {
      await fs.symlink(outside, link, 'junction')
    }
    const ctx = makeCtx(root)
    const result = await scanSessions(ctx)
    const symlink = result.findings.filter((f) => f.code === 'session-symlink')
    expect(symlink.length).toBeGreaterThan(0)
    expect(symlink[0]!.exposure).toContain('not followed')
    await cleanupTmp()
  })
})

describe('sessions: unreadable → skipped/error, not pass', () => {
  it('large session files are analyzed from the header only (no full read)', async () => {
    const root = await tmpHome({
      'sessions/--C-Users-admin-Desktop-dshext--/abc123/session.jsonl.zstd': Buffer.concat([safeFrame(), Buffer.alloc(70 * 1024, 0)]),
    })
    const ctx = makeCtx(root)
    const result = await scanSessions(ctx)
    const torn = result.checks.filter((c) => c.code === 'session-torn-frame')
    expect(torn.some((c) => c.state === 'pass')).toBe(true)
    expect(result.checks.some((c) => c.state === 'error')).toBe(false)
    await cleanupTmp()
  })

  it('missing session files do not count as pass', async () => {
    const root = await tmpHome({})
    const ctx = makeCtx(root)
    const result = await scanSessions(ctx)
    const torn = result.checks.filter((c) => c.code === 'session-torn-frame')
    expect(torn.some((c) => c.state === 'skipped' && c.skipReason === 'not-applicable')).toBe(true)
    expect(torn.some((c) => c.state === 'pass')).toBe(false)
    await cleanupTmp()
  })
})

afterAll(async () => {
  await cleanupTmp()
})
