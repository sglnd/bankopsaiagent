import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { requireIdentityRole, verifyIdentity } from '../identity.mjs'

const secret='test-identity-signing-secret-at-least-32-characters'

function requestFor(identity, signingSecret=secret) {
  const payload=Buffer.from(JSON.stringify(identity)).toString('base64url')
  return { headers:{
    'x-bankops-identity':payload,
    'x-bankops-identity-signature':createHmac('sha256',signingSecret).update(payload).digest('base64url'),
  } }
}

test('verifies a fresh signed identity context', () => {
  const identity=verifyIdentity(requestFor({tenantId:'t1',userId:'u1',roles:['OPERATOR'],issuedAt:Date.now()}),secret)
  assert.equal(identity.userId,'u1')
  assert.doesNotThrow(()=>requireIdentityRole(identity,['OPERATOR']))
})

test('rejects forged or expired identity contexts', () => {
  assert.throws(()=>verifyIdentity(requestFor({tenantId:'t1',userId:'u1',roles:[],issuedAt:Date.now()},'another-signing-secret-at-least-32-characters'),secret),/signature/)
  assert.throws(()=>verifyIdentity(requestFor({tenantId:'t1',userId:'u1',roles:[],issuedAt:Date.now()-120000}),secret),/expired/)
})

test('enforces signed identity roles when present', () => {
  assert.throws(()=>requireIdentityRole({roles:['OPERATOR']},['SKILL_DEVELOPER']),/permissions/)
  assert.doesNotThrow(()=>requireIdentityRole(null,['SKILL_DEVELOPER']))
})
