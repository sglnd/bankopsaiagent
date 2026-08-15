/**
 * 脱敏单元测试（设计 §6 脱敏设计 / §11.2 测试策略）。
 */

import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import * as path from 'node:path'
import {
  Redactor,
  classifySecret,
  displayUrl,
  redactPath,
  redactPathInText,
  safeErrorMessage,
  scanSecrets,
} from '../src/redact.ts'

describe('redact: secret scanning', () => {
  it('detects api-key style secrets with line numbers', () => {
    const text = 'line one\napi_key = sk-live-fake-not-a-real-key-0123456789abcdef\nline three'
    const hits = scanSecrets(text)
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits[0]!
    expect(hit.kind).toBe('api-key')
    expect(hit.line).toBe(2)
  })

  it('detects PEM private key headers', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nAAECAwQ='
    const hits = scanSecrets(text)
    expect(hits.some((h) => h.kind === 'private-key')).toBe(true)
  })

  it('skips allowlisted test tokens (safe fixture principle)', () => {
    const text = 'token = dsh_test_not_a_real_secret_abcdef123456'
    expect(scanSecrets(text)).toEqual([])
  })

  it('deduplicates overlapping pattern hits by value', () => {
    const text = 'API_KEY=sk-live-fake-not-a-real-key-0123456789abcdef'
    const hits = scanSecrets(text)
    expect(hits.filter((h) => h.value.includes('sk-live-fake'))).toHaveLength(1)
  })

  it('classifySecret returns kind/length', () => {
    const c = classifySecret('sk-live-fake-not-a-real-key-0123456789abcdef')
    expect(c).not.toBeNull()
    expect(c!.kind).toBe('api-key')
    expect(c!.length).toBeGreaterThan(12)
  })
})

describe('redact: fingerprint (HMAC, per-report)', () => {
  it('fingerprint is stable within one Redactor instance', () => {
    const r = new Redactor()
    expect(r.fingerprint('value-x')).toBe(r.fingerprint('value-x'))
  })

  it('fingerprint differs across Redactor instances (not cross-report trackable)', () => {
    const a = new Redactor()
    const b = new Redactor()
    expect(a.fingerprint('value-x')).not.toBe(b.fingerprint('value-x'))
  })

  it('secretEvidence never contains the full secret value', () => {
    const r = new Redactor()
    const secret = 'sk-live-fake-not-a-real-key-0123456789abcdef'
    const evidence = r.secretEvidence({ kind: 'api-key', value: secret, index: 0, line: 3 }, '$DSH_HOME/.env')
    const json = JSON.stringify(evidence)
    expect(json).not.toContain(secret)
    expect(evidence.secretLength).toBe(secret.length)
    expect(evidence.redacted).toBe(true)
    expect(evidence.line).toBe(3)
    expect(typeof evidence.fingerprint).toBe('string')
  })
})

describe('redact: path redaction', () => {
  const root = path.join(homedir(), '.dsh')
  const home = homedir()

  it('replaces the DSH root with $DSH_HOME', () => {
    const p = path.join(root, 'profiles', 'web', 'settings.yaml')
    expect(redactPath(p, root, home)).toBe('$DSH_HOME/profiles/web/settings.yaml')
  })

  it('replaces home paths with ~', () => {
    const p = path.join(home, 'Desktop', 'x.yaml')
    expect(redactPath(p, root, home)).toBe('~/Desktop/x.yaml')
  })

  it('falls back to basename for paths outside root and home (no other-user dirs)', () => {
    expect(redactPath('C:/Users/someone-else/.dsh/settings.yaml', root, home)).toBe('settings.yaml')
  })

  it('redacts root/home occurrences inside arbitrary text', () => {
    const text = `failed to read ${root}/settings.yaml and ${home}/.bashrc`
    const out = redactPathInText(text, root, home)
    expect(out).not.toContain(home)
    expect(out).toContain('$DSH_HOME/settings.yaml')
    expect(out).toContain('~/.bashrc')
  })
})

describe('redact: URL display and error messages', () => {
  it('strips userinfo and truncates long paths in displayUrl', () => {
    const d = displayUrl('https://user:super-secret-pass@api.example.com/very/long/path/segment/that/keeps/going')
    expect(d).not.toContain('super-secret-pass')
    expect(d).not.toContain('user:')
    expect(d).toContain('api.example.com')
    expect(d).toContain('***@')
  })

  it('safeErrorMessage redacts paths and truncates', () => {
    const root = path.join(homedir(), '.dsh')
    const msg = safeErrorMessage(new Error(`ENOENT ${root}/credentials.yaml`), root, homedir())
    expect(msg).not.toContain(homedir())
    expect(msg).toContain('$DSH_HOME/credentials.yaml')
  })
})
