/**
 * 路径 containment 测试（设计 §8 / §4.1：lstat → realpath → containment）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import {
  PathEscapeError,
  isWithinPath,
  readFileCapped,
  resolveContained,
  resolveDshHome,
} from '../src/paths.ts'
import { canCreateSymlink, cleanupTmp, tmpHome } from './helpers.ts'

describe('paths: string-level containment', () => {
  it('accepts direct children and equals', () => {
    expect(isWithinPath('/a/b', '/a/b/c')).toBe(true)
    expect(isWithinPath('/a/b', '/a/b')).toBe(true)
  })

  it('rejects siblings and prefix-lookalikes', () => {
    expect(isWithinPath('/a/b', '/a/c')).toBe(false)
    expect(isWithinPath('/a/b', '/a/bc')).toBe(false)
    expect(isWithinPath('/a/b', '/b/c')).toBe(false)
  })

  it('is case-insensitive on win32, sensitive on posix', () => {
    expect(isWithinPath('C:/Users/A/.dsh', 'c:/users/a/.dsh/x', true)).toBe(true)
    expect(isWithinPath('C:/Users/A/.dsh', 'C:/Users/a/.dsh/x', false)).toBe(false)
  })

  it('normalizes separators and dot segments', () => {
    expect(isWithinPath('C:\\Users\\A\\.dsh', 'C:/Users/A/.dsh/profiles/web', true)).toBe(true)
    expect(isWithinPath('/a/b', '/a/b/../c')).toBe(false)
  })
})

describe('paths: realpath containment (symlink escape)', () => {
  it('resolves a contained path and returns its real path', async () => {
    const root = await tmpHome({ 'inside/x.txt': 'x' })
    const res = await resolveContained(root, path.join(root, 'inside'))
    expect(res.real).toBe(await fs.realpath(path.join(root, 'inside')))
    await cleanupTmp()
  })

  it('rejects a symlink entry outright (lstat)', async () => {
    if (!(await canCreateSymlink())) {
      console.warn('symlink creation unavailable; skipping real-symlink escape test')
      return
    }
    const root = await tmpHome({ 'inside/keep.txt': 'x' })
    const outside = await tmpHome({ 'outside.txt': 'secret' })
    const link = path.join(root, 'inside', 'escape')
    try {
      await fs.symlink(outside, link, 'dir')
    } catch {
      await fs.symlink(outside, link, 'junction')
    }
    await expect(resolveContained(root, link)).rejects.toBeInstanceOf(PathEscapeError)
    await cleanupTmp()
  })

  it('rejects realpath escape through junction on win32', async () => {
    if (process.platform !== 'win32') return
    const root = await tmpHome({ 'inside/keep.txt': 'x' })
    const outside = await tmpHome({ 'outside.txt': 'secret' })
    const link = path.join(root, 'junction-escape')
    try {
      await fs.symlink(outside, link, 'junction')
    } catch {
      await cleanupTmp()
      return
    }
    await expect(resolveContained(root, link)).rejects.toBeInstanceOf(PathEscapeError)
    await cleanupTmp()
  })
})

describe('paths: capped reads and home resolution', () => {
  it('readFileCapped returns too-large without reading oversized files', async () => {
    const root = await tmpHome({ 'big.bin': Buffer.alloc(1024, 1) })
    const res = await readFileCapped(path.join(root, 'big.bin'), 100)
    expect(res.kind).toBe('too-large')
    if (res.kind === 'too-large') expect(res.size).toBe(1024)
    const ok = await readFileCapped(path.join(root, 'big.bin'), 2048)
    expect(ok.kind).toBe('ok')
    await cleanupTmp()
  })

  it('readFileCapped returns missing for nonexistent files', async () => {
    expect((await readFileCapped('/definitely/not/here.txt', 100)).kind).toBe('missing')
  })

  it('resolveDshHome prefers DSH_HOME env then ~/.dsh', () => {
    expect(resolveDshHome({ DSH_HOME: 'C:/custom/dsh' })).toBe('C:/custom/dsh')
    const noEnv = resolveDshHome({})
    expect(noEnv).toMatch(/\.dsh$/)
  })
})

afterAll(async () => {
  await cleanupTmp()
})
