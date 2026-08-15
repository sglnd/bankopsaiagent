import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { MAX_FILE_BYTES, scanInstructionChain } from '../src/scan.ts'

/** 基于 node:fs 的最小 FileSystem 假实现（只覆盖 scan 用到的子集）。 */
function fakeFs(): FileSystem {
  const fs = {
    async resolve(path: string, opts?: { cwd?: string }): Promise<unknown> {
      // 真实实现会把绝对路径原样归一化；这里用 resolve 模拟（join 不会重置绝对路径）
      return { targetKey: resolve(opts?.cwd ?? process.cwd(), path) }
    },
    processPath(target: { targetKey: string }): string {
      return target.targetKey
    },
    async stat(target: { targetKey: string }): Promise<unknown> {
      try {
        const st = statSync(target.targetKey)
        return {
          version: 1,
          type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
          size: st.size,
        }
      } catch {
        return undefined
      }
    },
    async readText(target: { targetKey: string }): Promise<string> {
      return readFileSync(target.targetKey, 'utf8')
    },
  }
  return fs as unknown as FileSystem
}

test('scanInstructionChain: 多层指令链 + git root + 重复检测', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    // tmp/repo/.git + tmp/repo/AGENTS.md + tmp/repo/sub/AGENTS.md + tmp/repo/sub/CLAUDE.md
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'sub'), { recursive: true })
    const shared = '# 全局规则\n这条规则在两个文件里完全一样，长度需要超过四十个字符才能通过最小长度过滤，这里写长一点。\n'
    writeFileSync(join(repo, 'AGENTS.md'), shared + '\n# repo 层规则\n')
    writeFileSync(join(repo, 'sub', 'AGENTS.md'), shared + '\n# sub 层规则\n')
    writeFileSync(join(repo, 'sub', 'CLAUDE.md'), '# 仅 CLAUDE 有\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, join(repo, 'sub'), new AbortController().signal)

    assert.equal(result.root, repo)
    assert.equal(result.files.length, 3)
    const paths = result.files.map((f) => f.path)
    assert.ok(paths.includes(join(repo, 'AGENTS.md')))
    assert.ok(paths.includes(join(repo, 'sub', 'AGENTS.md')))
    assert.ok(paths.includes(join(repo, 'sub', 'CLAUDE.md')))
    assert.ok(result.totalTokens > 0)

    // 重复块：shared 段落跨两个 AGENTS.md
    assert.equal(result.duplicateBlocks.length, 1)
    assert.equal(result.duplicateBlocks[0]!.paths.length, 2)
    assert.ok(result.duplicateBlocks[0]!.text.includes('全局规则'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 超过大小上限的文件被跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const big = 'x'.repeat(MAX_FILE_BYTES + 1024)
    writeFileSync(join(repo, 'AGENTS.md'), big)
    writeFileSync(join(repo, 'CLAUDE.md'), '# 小文件\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, repo, new AbortController().signal)
    assert.equal(result.files.length, 1)
    assert.ok(result.files[0]!.path.endsWith('CLAUDE.md'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanInstructionChain: 无 .git 时以 cwd 为根', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctxdoc-'))
  try {
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'AGENTS.md'), '# 无 git 仓库\n')

    const fs = fakeFs()
    const result = await scanInstructionChain(fs, plain, new AbortController().signal)
    assert.equal(result.root, plain)
    assert.equal(result.files.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
