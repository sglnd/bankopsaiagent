/**
 * 权限与平台策略测试（设计 §8：POSIX mode、Windows skipped、pass/skipped 语义）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { modeBits, credentialModeIssues, directoryModeIssues } from '../src/platform/posix.ts'
import { windowsAclUnsupported } from '../src/platform/windows.ts'
import { checkDirPermissions, checkFilePermissions, evaluateModeIssues } from '../src/platform/permissions.ts'
import { cleanupTmp, tmpHome } from './helpers.ts'

describe('permissions: POSIX mode bits (pure)', () => {
  it('parses mode bits per class', () => {
    const b = modeBits(0o640)
    expect(b.owner.r).toBe(true)
    expect(b.owner.w).toBe(true)
    expect(b.owner.x).toBe(false)
    expect(b.group.r).toBe(true)
    expect(b.other.r).toBe(false)
  })

  it('credential 0600 has no issues; 0644 group-read; 0666 other-read high', () => {
    expect(credentialModeIssues(0o600)).toEqual([])
    const g = credentialModeIssues(0o644)
    expect(g.some((i) => i.kind === 'group-read' && i.severity === 'medium')).toBe(true)
    const o = credentialModeIssues(0o666)
    expect(o.some((i) => i.kind === 'other-read' && i.severity === 'high')).toBe(true)
  })

  it('directory 0700 no issues; 0755 other-readable high', () => {
    expect(directoryModeIssues(0o700)).toEqual([])
    const d = directoryModeIssues(0o755)
    expect(d.some((i) => i.kind === 'other-read' && i.severity === 'high')).toBe(true)
  })

  it('evaluateModeIssues dispatches by kind', () => {
    expect(evaluateModeIssues(0o644, 'credential').some((i) => i.kind === 'group-read')).toBe(true)
    expect(evaluateModeIssues(0o644, 'session-file').some((i) => i.kind === 'group-read')).toBe(true)
    expect(evaluateModeIssues(0o755, 'directory').some((i) => i.kind === 'other-read')).toBe(true)
  })
})

describe('permissions: platform adaptation', () => {
  it('windows ACL checks are unsupported (skipped semantics, not pass)', () => {
    const w = windowsAclUnsupported()
    expect(w.supported).toBe(false)
    expect(w.reason).toContain('skipped')
  })

  it('checkFilePermissions on win32 returns supported:false', async () => {
    const root = await tmpHome({ 'credentials.yaml': 'a: 1' })
    const r = await checkFilePermissions(`${root}/credentials.yaml`, { platform: 'win32' })
    expect(r.supported).toBe(false)
    await cleanupTmp()
  })

  it('checkDirPermissions on win32 returns supported:false', async () => {
    const root = await tmpHome({ 'x': '1' })
    const r = await checkDirPermissions(root, { platform: 'win32' })
    expect(r.supported).toBe(false)
    await cleanupTmp()
  })

  it('missing files report unreadable, not pass', async () => {
    const r = await checkFilePermissions('/definitely/not/here', { platform: 'linux' })
    expect(r.supported).toBe(true)
    expect(r.unreadable).toBeDefined()
  })
})

afterAll(async () => {
  await cleanupTmp()
})
