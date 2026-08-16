/**
 * 权限检查适配层（设计 §8 权限与平台策略）。
 * - Windows：无零副作用 ACL API → supported:false（调用方记 skipped，不记 pass）；
 * - POSIX：owner/group/other mode 检查，不自动 chmod。
 */

import { promises as fs } from 'node:fs'
import { lstatSafe } from '../paths.ts'
import { credentialModeIssues, directoryModeIssues, sessionFileModeIssues, type ModeIssue } from './posix.ts'
import { windowsAclUnsupported } from './windows.ts'

export interface PermissionResult {
  supported: boolean
  reason?: string
  issues: ModeIssue[]
  /** 权限不足无法读取（lstat 失败）。 */
  unreadable?: string
}

export async function checkFilePermissions(
  p: string,
  opts: { platform?: NodeJS.Platform; signal?: AbortSignal } = {},
): Promise<PermissionResult> {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return { supported: false, reason: windowsAclUnsupported().reason, issues: [] }
  const stat = await lstatSafe(p)
  if (stat === null) return { supported: true, issues: [], unreadable: 'cannot stat file' }
  if (stat.isSymbolicLink()) return { supported: true, issues: [], unreadable: 'symbolic link (not followed)' }
  return { supported: true, issues: credentialModeIssues(stat.mode) }
}

export async function checkDirPermissions(
  p: string,
  opts: { platform?: NodeJS.Platform; signal?: AbortSignal } = {},
): Promise<PermissionResult> {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return { supported: false, reason: windowsAclUnsupported().reason, issues: [] }
  const stat = await lstatSafe(p)
  if (stat === null) return { supported: true, issues: [], unreadable: 'cannot stat directory' }
  return { supported: true, issues: directoryModeIssues(stat.mode) }
}

export async function checkSessionFilePermissions(
  p: string,
  opts: { platform?: NodeJS.Platform; signal?: AbortSignal } = {},
): Promise<PermissionResult> {
  const platform = opts.platform ?? process.platform
  if (platform === 'win32') return { supported: false, reason: windowsAclUnsupported().reason, issues: [] }
  const stat = await lstatSafe(p)
  if (stat === null) return { supported: true, issues: [], unreadable: 'cannot stat file' }
  return { supported: true, issues: sessionFileModeIssues(stat.mode) }
}

/** 供测试/纯逻辑使用的 mode 检查（无需真实文件）。 */
export function evaluateModeIssues(mode: number, kind: 'credential' | 'directory' | 'session-file'): ModeIssue[] {
  switch (kind) {
    case 'credential':
      return credentialModeIssues(mode)
    case 'directory':
      return directoryModeIssues(mode)
    case 'session-file':
      return sessionFileModeIssues(mode)
  }
}

/** 仅测试辅助：以指定 mode 创建一个临时文件（不用于审计路径）。 */
export async function statModeForTest(p: string): Promise<number | null> {
  const st = await fs.lstat(p).catch(() => null)
  return st === null ? null : st.mode
}
