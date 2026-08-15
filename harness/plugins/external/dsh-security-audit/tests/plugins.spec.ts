/**
 * scan_plugins 测试（设计 §7.2 + §11.2）。
 * 关键断言：能力 finding 是"能力提示"而非恶意结论；skipped/error 不计 pass。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { parsePatchRows } from '../src/plugins/patch.ts'
import { classifySource, installScripts } from '../src/plugins/package.ts'
import { scanSecrets } from '../src/redact.ts'
import type { AuditContext } from '../src/types.ts'
import { Redactor } from '../src/redact.ts'
import { cleanupTmp, findingCodes, pluginsFixture, runOnRisky, runOnSafe, seedFixtureNodeModules, tmpHome } from './helpers.ts'

function makeCtx(root: string, overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    action: 'scan_plugins',
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

async function copyDir(src: string, dest: string): Promise<void> {
  const { promises: fs } = await import('node:fs')
  await fs.mkdir(dest, { recursive: true })
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDir(s, d)
    else await fs.copyFile(s, d)
  }
}

describe('plugins: patch parsing', () => {
  it('parses insert sections with id/name/source rows', () => {
    const text = [
      '- insert:',
      '    - id: security-audit',
      "      name: '@deepseek-ai/dsh-security-audit'",
      '    - id: tool-ghost',
      '      name: @deepseek-ai/dsh-tool-ghost',
      '      source: git+https://github.com/example/x.git',
    ].join('\n')
    const { rows, ok } = parsePatchRows(text)
    expect(ok).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ id: 'security-audit', name: '@deepseek-ai/dsh-security-audit', section: 'insert' })
    expect(rows[1]!.source).toContain('git+https')
  })
})

describe('plugins: source classification', () => {
  it('detects unpinned vs pinned git sources', () => {
    expect(classifySource('git+https://github.com/a/b.git')).toMatchObject({ kind: 'git', pinned: false })
    expect(classifySource('git+https://github.com/a/b.git#abc1234')).toMatchObject({ kind: 'git', pinned: true })
    expect(classifySource('github:org/repo')).toMatchObject({ kind: 'git', pinned: false })
  })

  it('classifies npm/link/workspace/file', () => {
    expect(classifySource('npm:@x/y')).toMatchObject({ kind: 'npm' })
    expect(classifySource('link:../sibling')).toMatchObject({ kind: 'link' })
    expect(classifySource('workspace:../ws')).toMatchObject({ kind: 'workspace' })
    expect(classifySource('file:./local')).toMatchObject({ kind: 'file' })
    expect(classifySource(undefined)).toMatchObject({ kind: 'unknown' })
  })

  it('installScripts detects lifecycle scripts only', () => {
    const pkg = { scripts: { postinstall: 'node x.js', test: 'vitest' } }
    expect(installScripts(pkg as never)).toEqual(['postinstall'])
  })
})

describe('plugins: scanPlugins on fixtures', () => {
  let cleanupStubs: (() => Promise<void>) | undefined
  beforeAll(async () => { cleanupStubs = await seedFixtureNodeModules() })
  afterAll(async () => { await cleanupStubs?.() })

  it('safe fixture: declared plugin resolves; no plugin findings', async () => {
    const report = await runOnSafe({ action: 'scan_plugins' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(findingCodes(report)).toEqual([])
    const unresolved = report.checks.filter((c) => c.code === 'plugin-unresolved')
    expect(unresolved.some((c) => c.state === 'pass')).toBe(true)
  })

  it('risky fixture: unresolved plugin and unpinned git findings', async () => {
    const report = await runOnRisky({ action: 'scan_plugins' })
    if (!('findings' in report)) throw new Error('expected report')
    const codes = findingCodes(report)
    expect(codes).toContain('plugin-unresolved')
    expect(codes).toContain('plugin-unpinned-git')
  })

  it('risky fixture: package-name mismatch detection', async () => {
    const root = await tmpHome({
      'profiles/web/cordis.patch.yml': [
        '- insert:',
        '    - id: mismatch-row',
        "      name: '@deepseek-ai/declared-name'",
      ].join('\n'),
      'profiles/web/node_modules/@deepseek-ai/declared-name/package.json': JSON.stringify({
        name: '@deepseek-ai/actual-name',
        version: '1.0.0',
        main: 'index.js',
      }),
      'profiles/web/node_modules/@deepseek-ai/declared-name/index.js': 'export const x = 1\n',
    })
    const ctx = makeCtx(root)
    const { scanPlugins } = await import('../src/plugins/discover.ts')
    const result = await scanPlugins(ctx)
    expect(result.findings.some((f) => f.code === 'plugin-package-mismatch')).toBe(true)
    await cleanupTmp()
  })

  it('duplicate row ids are flagged', async () => {
    const root = await tmpHome({
      'profiles/a/cordis.patch.yml': '- insert:\n    - id: dup\n      name: pkg-a\n',
      'profiles/b/cordis.patch.yml': '- insert:\n    - id: dup\n      name: pkg-b\n',
    })
    const { scanPlugins } = await import('../src/plugins/discover.ts')
    const result = await scanPlugins(makeCtx(root))
    expect(result.findings.some((f) => f.code === 'duplicate-row-id')).toBe(true)
    await cleanupTmp()
  })
})

describe('plugins: source capability scan (opt-in)', () => {
  it('flags capabilities as hints, never as malicious verdicts', async () => {
    const root = await tmpHome({
      'profiles/web/cordis.patch.yml': '- insert:\n    - id: eval-fixture\n      name: @deepseek-ai/dsh-tool-eval-fixture\n',
    })
    await copyDir(path.join(pluginsFixture, 'dsh-tool-eval-fixture'), path.join(root, 'profiles/web/node_modules/@deepseek-ai/dsh-tool-eval-fixture'))
    const { scanPlugins } = await import('../src/plugins/discover.ts')
    const result = await scanPlugins(makeCtx(root, { includeSourceScan: true }))
    const codes = new Set(result.findings.map((f) => f.code))
    expect(codes.has('dynamic-code-execution')).toBe(true)
    expect(codes.has('process-execution-capability')).toBe(true)
    expect(codes.has('network-capability')).toBe(true)
    // 能力提示措辞：要求人工确认，不得宣称恶意
    for (const f of result.findings.filter((f) => f.code === 'dynamic-code-execution' || f.code === 'process-execution-capability')) {
      expect(f.exposure).toContain('manual confirmation')
      expect(f.exposure).not.toMatch(/malicious|malware|evil/i)
      expect(f.exposure).toContain('capability present')
    }
    // 能力 finding 不会携带源码完整片段
    const json = JSON.stringify(result)
    expect(json).not.toContain('(x) => x * 2')
    await cleanupTmp()
  })

  it('capability scan is skipped when includeSourceScan=false (not pass)', async () => {
    const root = await tmpHome({
      'profiles/web/cordis.patch.yml': '- insert:\n    - id: eval-fixture\n      name: @deepseek-ai/dsh-tool-eval-fixture\n',
    })
    await copyDir(path.join(pluginsFixture, 'dsh-tool-eval-fixture'), path.join(root, 'profiles/web/node_modules/@deepseek-ai/dsh-tool-eval-fixture'))
    const { scanPlugins } = await import('../src/plugins/discover.ts')
    const result = await scanPlugins(makeCtx(root))
    const cap = result.checks.filter((c) => c.code === 'dynamic-code-execution')
    expect(cap.length).toBeGreaterThan(0)
    expect(cap.every((c) => c.state === 'skipped' && c.skipReason === 'config')).toBe(true)
    expect(result.findings.some((f) => f.code === 'dynamic-code-execution')).toBe(false)
    await cleanupTmp()
  })

  it('install-script and secret-like-file findings for the fixture plugin', async () => {
    const root = await tmpHome({
      'profiles/web/cordis.patch.yml': '- insert:\n    - id: eval-fixture\n      name: @deepseek-ai/dsh-tool-eval-fixture\n',
    })
    await copyDir(path.join(pluginsFixture, 'dsh-tool-eval-fixture'), path.join(root, 'profiles/web/node_modules/@deepseek-ai/dsh-tool-eval-fixture'))
    const { scanPlugins } = await import('../src/plugins/discover.ts')
    const result = await scanPlugins(makeCtx(root))
    const codes = new Set(result.findings.map((f) => f.code))
    expect(codes.has('install-script')).toBe(true)
    expect(codes.has('secret-like-file')).toBe(true)
    // secret-like-file 的 evidence 不得包含 token 值
    const json = JSON.stringify(result)
    expect(json).not.toContain('dsh_test_not_a_real_secret_fixture_only')
    await cleanupTmp()
  })
})

describe('plugins: secret fixtures stay clean', () => {
  it('fixture tokens are explicitly invalid (no real credentials copied)', () => {
    const pkgEnv = `
      # fixture
      DSH_TEST_TOKEN=dsh_test_not_a_real_secret_fixture_only
    `
    expect(scanSecrets(pkgEnv)).toEqual([])
  })
})

afterAll(async () => {
  await cleanupTmp()
})
