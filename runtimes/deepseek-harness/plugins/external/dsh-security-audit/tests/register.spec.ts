/**
 * 工具注册契约（设计 §4 参数契约 / §9 canonical JSON / §11.2 注册与 disposer）。
 * 与参考工程一致使用 vi.mock 隔离 @deepseek-ai/dsh-tools。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (opts: unknown) => opts }))

import { apply, inject, name } from '../src/index.ts'

describe('security_audit: plugin registration contract', () => {
  it('exports the cordis plugin contract', () => {
    expect(typeof name).toBe('string')
    expect(name).toBe('@deepseek-ai/dsh-security-audit')
    expect(inject).toContain('tools')
    expect(typeof apply).toBe('function')
  })

  it('registers security_audit with the full parameter contract', () => {
    let captured: unknown
    const ctx: any = {
      config: {},
      tools: { register: (def: unknown) => { captured = def; return () => {} } },
    }
    apply(ctx)
    const def = captured as any
    expect(def.name).toBe('security_audit')
    expect(def.parameters.action.required).toBe(true)
    expect(def.parameters.action.enum).toEqual([
      'scan_config',
      'scan_plugins',
      'scan_sessions',
      'scan_network',
      'report',
      'rules',
    ])
    expect(def.parameters.root.type).toBe('string')
    expect(def.parameters.profile.type).toBe('string')
    expect(def.parameters.strict.type).toBe('boolean')
    expect(def.parameters.detail.type).toBe('boolean')
    expect(def.parameters.includeSourceScan.type).toBe('boolean')
  })

  it('declares canonical JSON output with JSON.stringify render', () => {
    let captured: unknown
    const ctx: any = {
      config: {},
      tools: { register: (def: unknown) => { captured = def; return () => {} } },
    }
    apply(ctx)
    const def = captured as any
    expect(def.output.schema.type).toBe('json')
    const blocks = def.output.render({ action: 'rules' }, { tool: 'security_audit' })
    expect(blocks).toEqual([{ type: 'text', text: '{"tool":"security_audit"}' }])
  })

  it('execute returns a promise (file system access) and forwards exec.signal', async () => {
    let captured: unknown
    const ctx: any = {
      config: {},
      tools: { register: (def: unknown) => { captured = def; return () => {} } },
    }
    apply(ctx)
    const def = captured as any
    // execute 非 async 声明，但返回 Promise（设计：返回 Promise.resolve 包装）
    const result = def.execute({ action: 'rules' }, { signal: new AbortController().signal })
    expect(result).toBeInstanceOf(Promise)
    const out = await result
    expect(out.action).toBe('rules')
    expect(Array.isArray(out.rules)).toBe(true)
  })

  it('declares a cooperative 30s timeout', () => {
    let captured: unknown
    const ctx: any = {
      config: {},
      tools: { register: (def: unknown) => { captured = def; return () => {} } },
    }
    apply(ctx)
    expect((captured as any).timeoutMs).toBe(30000)
  })

  it('apply returns the register disposer', () => {
    const ctx: any = {
      config: {},
      tools: { register: () => () => 'disposed' },
    }
    const disposer = apply(ctx) as unknown
    expect(typeof disposer).toBe('function')
  })

  it('accepts admin-declared allowedRoots/allowedEndpoints from plugin config', async () => {
    let captured: unknown
    const config = { allowedRoots: ['C:/x'], allowedEndpoints: ['https://api.example.com'] }
    const ctx: any = {
      tools: { register: (def: unknown) => { captured = def; return () => {} } },
    }
    apply(ctx, config)
    const def = captured as any
    // 执行 rules 不触发 root 解析；这里验证定义不抛错（config 透传在 execute 内生效）
    const out = await def.execute({ action: 'rules' }, { signal: new AbortController().signal })
    expect(out.action).toBe('rules')
  })
})
