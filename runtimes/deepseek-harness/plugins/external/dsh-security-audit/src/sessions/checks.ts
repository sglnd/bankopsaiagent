/**
 * scan_sessions 检查器（设计 §7.3 规则；只做安全相关有限规则，
 * 完整健康诊断交给 session_health，可在 recommendation 中建议调用）。
 */

import { LIMITS } from '../limits.ts'
import { readHeadCapped, throwIfAborted, throwIfDeadlineExceeded } from '../paths.ts'
import { redactPath, safeErrorMessage } from '../redact.ts'
import { RULE_BY_CODE } from '../rules.ts'
import type { AuditContext, CheckResult, Finding, ScannerResult } from '../types.ts'
import { discoverSessions, sessionsRootOf } from './discover.ts'
import { analyzeZstd } from './zstd-scan.ts'
import { checkDirPermissions, checkSessionFilePermissions } from '../platform/permissions.ts'

export async function scanSessions(ctx: AuditContext): Promise<ScannerResult> {
  const checks: CheckResult[] = []
  const findings: Finding[] = []
  const discovery = await discoverSessions(ctx.root, { signal: ctx.signal, deadline: ctx.deadline })
  const sessionsRoot = sessionsRootOf(ctx.root)
  const redactedRoot = redactPath(sessionsRoot, ctx.root, ctx.home)

  // 会话目录权限
  const rootPerm = await checkDirPermissions(sessionsRoot, { platform: ctx.platform })
  if (!discovery.rootExists) {
    checks.push({ code: 'session-root-permissions', state: 'skipped', subject: '(sessions)', severity: 'info', skipReason: 'not-applicable', reason: 'sessions root does not exist' })
    checks.push({ code: 'session-symlink', state: 'skipped', subject: '(sessions)', severity: 'info', skipReason: 'not-applicable', reason: 'sessions root does not exist' })
  } else if (!rootPerm.supported) {
    checks.push({ code: 'session-root-permissions', state: 'skipped', subject: '(sessions)', severity: 'info', skipReason: 'platform', ...(rootPerm.reason !== undefined ? { reason: rootPerm.reason } : {}) })
  } else if (rootPerm.unreadable) {
    checks.push({ code: 'session-root-permissions', state: 'skipped', subject: '(sessions)', severity: 'info', skipReason: 'permission', reason: rootPerm.unreadable })
  } else if (rootPerm.issues.length === 0) {
    checks.push({ code: 'session-root-permissions', state: 'pass', subject: '(sessions)', severity: 'info' })
  } else {
    const worst = rootPerm.issues.some((i) => i.severity === 'high') ? 'high' : 'medium'
    findings.push({
      severity: worst,
      code: 'session-root-permissions',
      category: 'sessions',
      subject: '(sessions)',
      evidence: { path: redactedRoot, redacted: true },
      exposure: 'sessions directory permissions are broader than recommended (0700)',
      recommendation: 'restrict the sessions directory to the owning user only',
      confidence: 'high',
      ruleVersion: RULE_BY_CODE.get('session-root-permissions')?.ruleVersion ?? 1,
    })
    checks.push({ code: 'session-root-permissions', state: 'finding', subject: '(sessions)', severity: worst, reason: rootPerm.issues.map((i) => i.detail).join('; ') })
  }

  let symlinks = 0
  let sessionFiles = 0
  for (const entry of discovery.entries) {
    throwIfAborted(ctx.signal)
    throwIfDeadlineExceeded(ctx.deadline, ctx.signal)

    if (entry.kind === 'symlink') {
      symlinks++
      findings.push({
        severity: 'high',
        code: 'session-symlink',
        category: 'sessions',
        subject: entry.rel,
        evidence: { path: redactPath(entry.path, ctx.root, ctx.home), redacted: true },
        exposure: 'symbolic link/reparse point present in sessions directory; not followed, may escape containment',
        recommendation: 'remove symlinks from the sessions directory',
        confidence: 'high',
        ruleVersion: RULE_BY_CODE.get('session-symlink')?.ruleVersion ?? 1,
      })
      checks.push({ code: 'session-symlink', state: 'finding', subject: entry.rel, severity: 'high' })
      continue
    }

    if (entry.kind === 'stray') {
      findings.push({
        severity: 'low',
        code: 'session-temp-residue',
        category: 'sessions',
        subject: entry.rel,
        evidence: { path: redactPath(entry.path, ctx.root, ctx.home), redacted: true },
        exposure: 'temporary/residual file present in sessions directory',
        recommendation: 'remove leftover temporary files',
        confidence: 'high',
        ruleVersion: RULE_BY_CODE.get('session-temp-residue')?.ruleVersion ?? 1,
      })
      checks.push({ code: 'session-temp-residue', state: 'finding', subject: entry.rel, severity: 'low' })
      continue
    }

    if (entry.kind !== 'session') {
      // 其它类型（如目录）不计入 session 文件
      checks.push({ code: 'session-file-permissions', state: 'skipped', subject: entry.rel, severity: 'info', skipReason: 'not-applicable', reason: 'not a session file' })
      continue
    }

    sessionFiles++
    // 文件权限（平台适配）
    const filePerm = await checkSessionFilePermissions(entry.path, { platform: ctx.platform })
    if (filePerm.supported && !filePerm.unreadable && filePerm.issues.length > 0) {
      const worst = filePerm.issues.some((i) => i.severity === 'high') ? 'high' : 'medium'
      findings.push({
        severity: worst,
        code: 'session-file-permissions',
        category: 'sessions',
        subject: entry.rel,
        evidence: { path: redactPath(entry.path, ctx.root, ctx.home), redacted: true },
        exposure: 'session file readable by other users/groups',
        recommendation: 'restrict session files to 0600',
        confidence: 'high',
        ruleVersion: RULE_BY_CODE.get('session-file-permissions')?.ruleVersion ?? 1,
      })
      checks.push({ code: 'session-file-permissions', state: 'finding', subject: entry.rel, severity: worst })
    } else if (filePerm.supported && !filePerm.unreadable) {
      checks.push({ code: 'session-file-permissions', state: 'pass', subject: entry.rel, severity: 'info' })
    } else if (!filePerm.supported) {
      checks.push({ code: 'session-file-permissions', state: 'skipped', subject: entry.rel, severity: 'info', skipReason: 'platform', ...(filePerm.reason !== undefined ? { reason: filePerm.reason } : {}) })
    } else {
      checks.push({ code: 'session-file-permissions', state: 'skipped', subject: entry.rel, severity: 'info', skipReason: 'permission', ...(filePerm.unreadable !== undefined ? { reason: filePerm.unreadable } : {}) })
    }

    // zstd stage-1 分析（只读头部）
    const read = await readHeadCapped(entry.path, LIMITS.sessionHeaderReadBytes, ctx.signal)
    if (read.kind === 'ok') {
      const analysis = analyzeZstd(read.buf, entry.bytes)
      const redactedPath = redactPath(entry.path, ctx.root, ctx.home)
      if (!analysis.isZstd) {
        findings.push({
          severity: 'low',
          code: 'session-non-zstd',
          category: 'sessions',
          subject: entry.rel,
          evidence: { path: redactedPath, redacted: true },
          exposure: 'file at an expected zstd session location is not a zstd stream',
          recommendation: 'verify the file is a real session file; run session_health for full diagnosis',
          confidence: 'high',
          ruleVersion: RULE_BY_CODE.get('session-non-zstd')?.ruleVersion ?? 1,
        })
        checks.push({ code: 'session-non-zstd', state: 'finding', subject: entry.rel, severity: 'low' })
      } else {
        if (analysis.torn) {
          findings.push({
            severity: 'medium',
            code: 'session-torn-frame',
            category: 'sessions',
            subject: entry.rel,
            evidence: { path: redactedPath, redacted: true },
            exposure: 'zstd frame is truncated or incomplete (torn write)',
            recommendation: 'run session_health for full diagnosis; consider whether the session is recoverable',
            confidence: 'high',
            ruleVersion: RULE_BY_CODE.get('session-torn-frame')?.ruleVersion ?? 1,
          })
          checks.push({ code: 'session-torn-frame', state: 'finding', subject: entry.rel, severity: 'medium' })
        } else {
          checks.push({ code: 'session-torn-frame', state: 'pass', subject: entry.rel, severity: 'info' })
        }
        const fcs = analysis.fcs
        if (fcs !== undefined && fcs > LIMITS.oversizedFrameBytes) {
          findings.push({
            severity: 'medium',
            code: 'session-oversized-frame',
            category: 'sessions',
            subject: entry.rel,
            evidence: { path: redactedPath, value: `${fcs} bytes`, redacted: true },
            exposure: 'frame declares a content size above the per-file budget',
            recommendation: 'do not decompress this file; investigate its origin',
            confidence: 'high',
            ruleVersion: RULE_BY_CODE.get('session-oversized-frame')?.ruleVersion ?? 1,
          })
          checks.push({ code: 'session-oversized-frame', state: 'finding', subject: entry.rel, severity: 'medium' })
        } else {
          checks.push({ code: 'session-oversized-frame', state: 'pass', subject: entry.rel, severity: 'info' })
        }
        // expansion ratio：必须同时满足绝对输出量下限（避免小文件误报）
        if (
          fcs !== undefined &&
          fcs >= LIMITS.expansionAbsoluteFloor &&
          entry.bytes > 0 &&
          fcs / entry.bytes > LIMITS.expansionRatioWarn
        ) {
          findings.push({
            severity: 'high',
            code: 'session-suspicious-expansion',
            category: 'sessions',
            subject: entry.rel,
            evidence: { path: redactedPath, value: `ratio≈${Math.round(fcs / entry.bytes)}:1`, redacted: true },
            exposure: 'declared content size vs compressed size suggests an abnormal expansion ratio (possible decompression bomb)',
            recommendation: 'do not decompress this file; quarantine it and investigate its origin',
            confidence: 'medium',
            ruleVersion: RULE_BY_CODE.get('session-suspicious-expansion')?.ruleVersion ?? 1,
          })
          checks.push({ code: 'session-suspicious-expansion', state: 'finding', subject: entry.rel, severity: 'high' })
        } else {
          checks.push({ code: 'session-suspicious-expansion', state: 'pass', subject: entry.rel, severity: 'info' })
        }
      }
    } else if (read.kind === 'too-large') {
      checks.push({ code: 'session-non-zstd', state: 'skipped', subject: entry.rel, severity: 'info', skipReason: 'budget', reason: `file exceeds header read budget (${LIMITS.sessionHeaderReadBytes} bytes)` })
    } else if (read.kind === 'error') {
      checks.push({ code: 'session-non-zstd', state: 'error', subject: entry.rel, severity: 'info', reason: safeErrorMessage(read.message, ctx.root, ctx.home) })
    }
  }

  if (sessionFiles === 0 && symlinks === 0) {
    checks.push({ code: 'session-torn-frame', state: 'skipped', subject: '(sessions)', severity: 'info', skipReason: 'not-applicable', reason: discovery.rootExists ? 'no session files found' : 'sessions root does not exist' })
  }

  return { checks, findings, truncated: discovery.truncated }
}

export { isTempResidue } from './zstd-scan.ts'
