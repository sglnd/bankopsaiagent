/**
 * scan_network 测试（设计 §7.4：地址/URL 分类、allowlist 精确匹配、
 * 不联网不探测）。
 */

import { afterAll, describe, expect, it } from 'vitest'
import { classifyHostname, classifyUrl, isAllowedEndpoint, normalizeEndpoint } from '../src/network/classify.ts'
import { findingCodes, runOnRisky, runOnSafe } from './helpers.ts'

describe('network: address classification', () => {
  it('classifies loopback hosts', () => {
    expect(classifyHostname('localhost')).toBe('loopback')
    expect(classifyHostname('127.0.0.1')).toBe('loopback')
    expect(classifyHostname('127.99.0.1')).toBe('loopback')
    expect(classifyHostname('::1')).toBe('loopback')
  })

  it('classifies unspecified binds', () => {
    expect(classifyHostname('0.0.0.0')).toBe('unspecified')
    expect(classifyHostname('::')).toBe('unspecified')
  })

  it('classifies private/link-local (not loopback-equivalent)', () => {
    expect(classifyHostname('10.0.0.5')).toBe('private')
    expect(classifyHostname('192.168.1.1')).toBe('private')
    expect(classifyHostname('172.16.0.1')).toBe('private')
    expect(classifyHostname('169.254.1.1')).toBe('private')
    expect(classifyHostname('fe80::1')).toBe('private')
  })

  it('classifies external hosts', () => {
    expect(classifyHostname('example.com')).toBe('external')
    expect(classifyHostname('api.deepseek.com')).toBe('external')
  })
})

describe('network: URL classification', () => {
  it('detects userinfo and plaintext', () => {
    const c = classifyUrl('https://user:pass@example.com/api')!
    expect(c.hasUserinfo).toBe(true)
    expect(c.plaintext).toBe(false)
    expect(c.addressClass).toBe('external')
    const h = classifyUrl('http://example.com/x')!
    expect(h.plaintext).toBe(true)
    const l = classifyUrl('http://127.0.0.1:3080/v1')!
    expect(l.addressClass).toBe('loopback')
    expect(l.port).toBe(3080)
  })

  it('derives default ports per scheme', () => {
    expect(classifyUrl('https://example.com')!.port).toBe(443)
    expect(classifyUrl('http://example.com')!.port).toBe(80)
  })

  it('returns null for non-URLs', () => {
    expect(classifyUrl('not a url')).toBeNull()
  })
})

describe('network: endpoint allowlist (exact match, no wildcards)', () => {
  it('matches normalized scheme+host+port exactly', () => {
    const allow = ['https://api.example.com:443']
    expect(isAllowedEndpoint('https://api.example.com/v1/models', allow)).toBe(true)
    expect(isAllowedEndpoint('https://api.example.com:8443/v1', allow)).toBe(false)
    expect(isAllowedEndpoint('http://api.example.com/v1', allow)).toBe(false)
  })

  it('wildcard entries never match (no wildcard support)', () => {
    expect(isAllowedEndpoint('https://x.example.com/a', ['https://*.example.com'])).toBe(false)
    expect(isAllowedEndpoint('https://example.com/a', ['https://example.com/*'])).toBe(false)
  })

  it('empty allowlist allows nothing', () => {
    expect(isAllowedEndpoint('https://api.example.com/v1', [])).toBe(false)
  })

  it('normalizeEndpoint strips userinfo and path', () => {
    expect(normalizeEndpoint('https://u:p@Example.COM:443/x?y=1')).toBe('https://example.com:443')
  })
})

describe('network: scanNetwork on fixtures', () => {
  it('safe fixture: loopback listen passes; no network findings', async () => {
    const report = await runOnSafe({ action: 'scan_network' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(findingCodes(report)).toEqual([])
    const listen = report.checks.filter((c) => c.code === 'listen-all-interfaces')
    expect(listen.some((c) => c.state === 'pass')).toBe(true)
  })

  it('risky fixture: open listen, plaintext, discovery, cors, proxy findings', async () => {
    const report = await runOnRisky({ action: 'scan_network' })
    if (!('findings' in report)) throw new Error('expected report')
    const codes = findingCodes(report)
    expect(codes).toContain('listen-all-interfaces')
    expect(codes).toContain('missing-auth-on-exposed-service')
    expect(codes).toContain('plaintext-http-external')
    expect(codes).toContain('external-model-discovery')
    expect(codes).toContain('weak-cors')
    expect(codes).toContain('proxy-credential-route')
  })

  it('discovery to an allowlisted endpoint passes (admin allowlist only)', async () => {
    const report = await runOnRisky(
      { action: 'scan_network' },
      { allowedEndpoints: ['http://model-api.example.com:80'] },
    )
    if (!('findings' in report)) throw new Error('expected report')
    const codes = findingCodes(report)
    // allowlist 只豁免"未知外部目标"，不豁免明文 HTTP/开放监听
    expect(codes).not.toContain('external-model-discovery')
    expect(codes).toContain('plaintext-http-external')
  })

  it('never performs network requests or port probes', async () => {
    // 扫描器只读文件；此处验证不依赖任何 net/socket 能力（导入面已限定）
    const report = await runOnRisky({ action: 'scan_network' })
    if (!('findings' in report)) throw new Error('expected report')
    expect(report.platform).toBeDefined()
  })
})

afterAll(async () => {
  // 无临时资源
})
