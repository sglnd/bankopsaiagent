/**
 * 可选源码能力扫描（设计 §7.2 source-capabilities）。
 * includeSourceScan=true 时启用；只提示能力存在，绝不裁定恶意（§7.2 重要）。
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import { LIMITS } from '../limits.ts'
import { lstatSafe, throwIfAborted, throwIfDeadlineExceeded } from '../paths.ts'
import { redactPath } from '../redact.ts'
import { RULE_BY_CODE } from '../rules.ts'
import type { AuditContext, Finding } from '../types.ts'

interface CapPattern {
  code: 'dynamic-code-execution' | 'process-execution-capability' | 'network-capability'
  re: RegExp
}

const CAP_PATTERNS: readonly CapPattern[] = [
  { code: 'dynamic-code-execution', re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(runInThisContext|runInNewContext|createScript|compileFunction)|\brequire\s*\(\s*['"]vm['"]\)/ },
  { code: 'process-execution-capability', re: /child_process|\b\.spawn\s*\(|\b\.exec(?:File)?\s*\(|\bfork\s*\(|worker_threads|\bnew\s+Worker\s*\(/ },
  { code: 'network-capability', re: /\brequire\s*\(\s*['"](?:node:)?(?:net|http|https|dgram)['"]\)|\bfrom\s+['"](?:node:)?(?:net|http|https|dgram)['"]|\bfetch\s*\(|\bnew\s+WebSocket\s*\(/ },
]

export interface SourceScanState {
  files: number
  bytes: number
  truncated: boolean
}

export interface CapabilityHit {
  code: CapPattern['code']
  file: string
  line: number
  match: string
}

export async function scanSourceCapabilities(
  pkgDir: string,
  opts: { signal?: AbortSignal; deadline: number; state: SourceScanState },
): Promise<{ hits: CapabilityHit[]; warnings: string[] }> {
  const hits: CapabilityHit[] = []
  const warnings: string[] = []
  const seen = new Set<string>()

  const visitFile = async (file: string): Promise<void> => {
    if (opts.state.files >= LIMITS.sourceFiles) {
      opts.state.truncated = true
      return
    }
    const stat = await lstatSafe(file)
    if (stat === null) return
    if (stat.isSymbolicLink()) return
    if (!stat.isFile()) return
    if (stat.size > LIMITS.sourceFileBytes) {
      opts.state.files++
      return
    }
    if (opts.state.bytes + stat.size > LIMITS.sourceTotalBytes) {
      opts.state.truncated = true
      return
    }
    opts.state.files++
    opts.state.bytes += stat.size
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      warnings.push(`cannot read source file: ${file}`)
      return
    }
    if (text.length > LIMITS.sourceFileBytes) return
    for (const { code, re } of CAP_PATTERNS) {
      const regex = new RegExp(re.source, 'g')
      for (const m of text.matchAll(regex)) {
        const key = `${code}:${file}:${m.index ?? 0}`
        if (seen.has(key)) continue
        seen.add(key)
        let line = 1
        for (let i = 0; i < (m.index ?? 0) && i < text.length; i++) {
          if (text.charCodeAt(i) === 10) line++
        }
        hits.push({ code, file, line, match: m[0].slice(0, 40) })
      }
    }
  }

  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfAborted(opts.signal)
    throwIfDeadlineExceeded(opts.deadline, opts.signal)
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      throwIfAborted(opts.signal)
      throwIfDeadlineExceeded(opts.deadline, opts.signal)
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      const stat = await lstatSafe(full)
      if (stat === null) continue
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await walk(full, depth + 1)
      } else if (stat.isFile() && /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(entry.name)) {
        await visitFile(full)
      }
    }
  }

  await walk(pkgDir, 0)
  return { hits, warnings }
}

/**
 * 将能力命中转为 finding：能力 ≠ 恶意（设计 §7.2 重要），
 * exposure 明确要求人工确认用途，confidence 保持 medium/high 但措辞中性。
 */
export function capabilityFindings(ctx: AuditContext, pkgName: string, hits: CapabilityHit[]): Finding[] {
  const findings: Finding[] = []
  const exposures: Record<CapPattern['code'], string> = {
    'dynamic-code-execution': 'source contains dynamic code execution capability (eval/new Function/vm) — capability present, intended use requires manual confirmation',
    'process-execution-capability': 'source contains process execution capability (child_process/spawn/worker) — capability present, intended use requires manual confirmation',
    'network-capability': 'source contains network capability (net/http/fetch/websocket) — capability present, intended use requires manual confirmation',
  }
  const recommendations: Record<CapPattern['code'], string> = {
    'dynamic-code-execution': 'review the call sites and confirm they only execute trusted, non-config-derived code',
    'process-execution-capability': 'confirm spawned processes and their arguments are not attacker-controlled',
    'network-capability': 'confirm outbound targets are allowlisted and TLS is used',
  }
  for (const hit of hits) {
    const rule = RULE_BY_CODE.get(hit.code)
    findings.push({
      severity: rule?.severity ?? 'medium',
      code: hit.code,
      category: 'plugins',
      subject: `plugin:${pkgName}:${path.relative(ctx.root, hit.file).replace(/\\/g, '/')}:${hit.line}`,
      evidence: {
        path: redactPath(hit.file, ctx.root, ctx.home),
        line: hit.line,
        value: hit.match,
        redacted: false,
      },
      exposure: exposures[hit.code],
      recommendation: recommendations[hit.code],
      confidence: 'medium',
      ruleVersion: rule?.ruleVersion ?? 1,
    })
  }
  return findings
}

/** secret-like-file：插件包中携带 .env / *.pem / *.key / id_rsa 等。 */
export async function findSecretLikeFiles(
  pkgDir: string,
  opts: { signal?: AbortSignal; deadline: number },
): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    throwIfAborted(opts.signal)
    if (depth > 2) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const stat = await lstatSafe(full)
      if (stat === null || stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full, depth + 1)
      } else if (stat.isFile()) {
        if (/\.(pem|key|p12|pfx|keystore)$/i.test(entry.name) || /^id_rsa$/.test(entry.name) || entry.name === '.env') {
          found.push(full)
        }
      }
    }
  }
  await walk(pkgDir, 0)
  return found
}
