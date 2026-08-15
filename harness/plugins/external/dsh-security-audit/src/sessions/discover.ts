/**
 * session 文件发现（设计 §7.3）：扫描 $DSH_HOME/sessions 两级布局。
 * 与 dsh-session-health 布局一致：<root>/<cwd 编码>/<session-id>/session.jsonl.zstd
 * 加 stray 文件（*.tmp / *.tmp.zstd）。只读；lstat 拒绝 symlink。
 */

import { promises as fs } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import * as path from 'node:path'
import { LIMITS } from '../limits.ts'
import { lstatSafe, throwIfAborted, throwIfDeadlineExceeded } from '../paths.ts'

export interface SessionEntry {
  path: string
  /** 相对 sessions root 的路径（正斜杠）。 */
  rel: string
  name: string
  kind: 'session' | 'stray' | 'symlink' | 'other'
  bytes: number
  isDirectory: boolean
}

export interface SessionsDiscovery {
  entries: SessionEntry[]
  truncated: boolean
  warnings: string[]
  rootExists: boolean
}

export function sessionsRootOf(dshHome: string): string {
  return path.join(dshHome, 'sessions')
}

export async function discoverSessions(
  root: string,
  opts: { signal?: AbortSignal; deadline: number; maxFiles?: number } = { deadline: Number.POSITIVE_INFINITY },
): Promise<SessionsDiscovery> {
  const maxFiles = opts.maxFiles ?? LIMITS.sessionFiles
  const entries: SessionEntry[] = []
  const warnings: string[] = []
  const rootDir = sessionsRootOf(root)
  const rootStat = await lstatSafe(rootDir)
  if (rootStat === null) {
    return { entries, truncated: false, warnings: [`sessions root does not exist: ${rootDir}`], rootExists: false }
  }
  if (!rootStat.isDirectory()) {
    return { entries, truncated: false, warnings: [`sessions root is not a directory: ${rootDir}`], rootExists: false }
  }

  const state = { count: 0, truncated: false }

  const classify = (name: string, stat: Stats): SessionEntry['kind'] => {
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'other'
    if (name === 'session.jsonl.zstd' || name.endsWith('.zstd') || name.endsWith('.zst')) return 'session'
    if (/\.(tmp|part)(\.zstd)?$/.test(name) || name.endsWith('~')) return 'stray'
    return 'other'
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfAborted(opts.signal)
    throwIfDeadlineExceeded(opts.deadline, opts.signal)
    if (depth > 2) return
    let list: Dirent[]
    try {
      list = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      warnings.push(`cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of list) {
      throwIfAborted(opts.signal)
      throwIfDeadlineExceeded(opts.deadline, opts.signal)
      if (state.count >= maxFiles) {
        state.truncated = true
        return
      }
      const full = path.join(dir, entry.name)
      const stat = await lstatSafe(full)
      if (stat === null) continue
      const kind = classify(entry.name, stat)
      if (kind === 'other' && stat.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      state.count++
      entries.push({
        path: full,
        rel: path.relative(rootDir, full).replace(/\\/g, '/'),
        name: entry.name,
        kind,
        bytes: stat.size,
        isDirectory: stat.isDirectory(),
      })
    }
  }

  await walk(rootDir, 0)
  return { entries, truncated: state.truncated, warnings, rootExists: true }
}
