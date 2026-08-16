import test from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, normalizeUsername, parseCookies, tokenHash, validatePassword, validateUsername, verifyPassword } from '../src/security.mjs'

test('validates normalized usernames and passwords with two of three character categories', () => {
  assert.equal(normalizeUsername(' Alice.OP '),'alice.op')
  assert.equal(validateUsername('alice.op'),true)
  assert.equal(validateUsername('1alice'),false)
  assert.equal(validatePassword('letters12'),true)
  assert.equal(validatePassword('letters@!'),true)
  assert.equal(validatePassword('1234567@!'),true)
  assert.equal(validatePassword('lettersOnly'),false)
  assert.equal(validatePassword('123456789'),false)
  assert.equal(validatePassword('!@#$%^&*()'),false)
  assert.equal(validatePassword('short1!'),false)
  assert.equal(validatePassword(`${'a'.repeat(127)}1`),true)
  assert.equal(validatePassword(`${'a'.repeat(128)}1`),false)
})

test('hashes and verifies passwords without storing plaintext', async () => {
  const value = await hashPassword('StrongPassword@2026')
  assert.equal(await verifyPassword('StrongPassword@2026',value.salt,value.hash),true)
  assert.equal(await verifyPassword('WrongPassword@2026',value.salt,value.hash),false)
  assert.notEqual(value.hash,tokenHash('StrongPassword@2026'))
})

test('parses session cookies', () => {
  assert.deepEqual(parseCookies('bankops_session=abc; bankops_csrf=xyz'),{bankops_session:'abc',bankops_csrf:'xyz'})
})
