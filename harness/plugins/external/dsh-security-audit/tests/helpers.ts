/**
 * 测试共享辅助：fixture 路径、临时 home、zstd 帧构造、运行便捷封装。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAction } from '../src/runner.ts'
import type { AuditParams, AuditReport, RulesOutput, RunOptions } from '../src/types.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const fixturesDir = path.resolve(here, '..', 'fixtures')
export const safeHome = path.join(fixturesDir, 'safe-home')
export const riskyHome = path.join(fixturesDir, 'risky-home')
export const pluginsFixture = path.join(fixturesDir, 'plugins')

export async function runAudit(params: AuditParams, opts: RunOptions = {}): Promise<AuditReport | RulesOutput> {
  return runAction(params, opts)
}

/** 以 safe-home 为 fixedRoot 运行（report.root 显示为 $DSH_HOME）。 */
export async function runOnSafe(params: AuditParams, opts: RunOptions = {}): Promise<AuditReport | RulesOutput> {
  return runAction(params, { fixedRoot: safeHome, ...opts })
}

/** 以 risky-home 为 fixedRoot 运行。 */
export async function runOnRisky(params: AuditParams, opts: RunOptions = {}): Promise<AuditReport | RulesOutput> {
  return runAction(params, { fixedRoot: riskyHome, ...opts })
}

const createdTmp: string[] = []

export async function tmpHome(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-audit-test-'))
  createdTmp.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return root
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(createdTmp.splice(0).map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)))
}

export function findingCodes(report: { findings: AuditReport['findings'] }): string[] {
  return [...report.findings.map((f) => f.code)].sort()
}

export function checksByCode(report: AuditReport, code: string): AuditReport['checks'] {
  return report.checks.filter((c) => c.code === code)
}

// ---------------------------------------------------------------------------
// zstd 帧构造（与 src/sessions/zstd-scan.ts 解析逻辑保持一致）
// ---------------------------------------------------------------------------

/**
 * Seed the safe/risky fixture node_modules stubs so plugin resolution tests
 * are hermetic on a clean checkout. node_modules/ is gitignored, so the stubs
 * must be created at test time rather than committed.
 */
export async function seedFixtureNodeModules(): Promise<() => Promise<void>> {
  const stubPkg = {
    name: '@deepseek-ai/dsh-tool-regex',
    version: '0.0.1',
    type: 'module',
    main: 'index.js',
  }
  const stubIndex = 'export const name = "@deepseek-ai/dsh-tool-regex"; export const inject = ["tools"]; export function apply() {}\n'
  const created: string[] = []
  for (const home of [safeHome]) {
    const dir = path.join(home, 'node_modules', '@deepseek-ai', 'dsh-tool-regex')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(stubPkg, null, 2) + '\n')
    await fs.writeFile(path.join(dir, 'index.js'), stubIndex)
    created.push(dir)
  }
  return async () => {
    await Promise.all(created.map(p => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)))
  }
}

/** 合法帧：FCS=10，单 raw block size 0。 */
export function safeFrame(): Buffer {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x0a, 0x01, 0x00, 0x00])
}

/** 截断帧：magic + descriptor，缺 FCS/block。 */
export function tornFrame(): Buffer {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20])
}

/** FCS=17MiB（超预算 + 高 ratio）。 */
export function oversizedFrame(): Buffer {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0x00, 0x00, 0x0f, 0x01, 0x01, 0x00, 0x00, 0x00])
}

/** FCS=2MiB（高 ratio，未超预算）。 */
export function suspiciousFrame(): Buffer {
  return Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0x00, 0x00, 0x1f, 0x00, 0x01, 0x00, 0x00])
}

// ---------------------------------------------------------------------------
// symlink 能力探测（Windows 需要开发者模式/管理员；目录 junction 通常可用）
// ---------------------------------------------------------------------------

export async function canCreateSymlink(): Promise<boolean> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'dsh-symlink-probe-'))
  try {
    const target = path.join(dir, 'target')
    const link = path.join(dir, 'link')
    await fs.mkdir(target)
    try {
      await fs.symlink(target, link, 'dir')
    } catch {
      await fs.symlink(target, link, 'junction')
    }
    return true
  } catch {
    return false
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
