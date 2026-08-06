// Credential-free authored-byte projection shared by the live off-box writer and its
// derive-only shadow. This module cannot sign, submit, journal, or load credentials.
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { assertPolicyDecision, canonicalJson } from './buzz_policy_core.mjs'
import { renderQuarantineHeader } from './quarantine_projection.mjs'
import { renderReleased } from './render.mjs'

const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROJECTION_POLICIES = new WeakSet()
const fail = message => { throw new Error(`buzz-policy-projection: ${message}`) }
const hex = (value, label, pattern = HEX64) => {
  const text = String(value || '').toLowerCase()
  if (!pattern.test(text)) fail(`${label} is invalid`)
  return text
}
const timestamp = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('timestamp is invalid')
  return value
}

export function createProjectionPolicy({ posterPubkey, authTag } = {}) {
  const poster = hex(posterPubkey, 'posterPubkey')
  if (!Array.isArray(authTag) || authTag.length !== 4 || authTag[0] !== 'auth' ||
      !authTag.every(value => typeof value === 'string')) fail('authTag must be the fixed four-field NIP-OA tag')
  const owner = hex(authTag[1], 'authTag owner'), signature = hex(authTag[3], 'authTag signature', HEX128)
  const attestation = sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${authTag[2]}`))
  if (!schnorr.verify(hexToBytes(signature), attestation, hexToBytes(owner))) fail('authTag owner signature is invalid for this poster')
  const policy = Object.freeze({ posterPubkey: poster, authTag: Object.freeze([...authTag]) })
  PROJECTION_POLICIES.add(policy)
  return policy
}

const projectionPolicy = policy => {
  if (!policy || !PROJECTION_POLICIES.has(policy)) fail('an internally configured projection policy is required')
  return policy
}

export function buildBuzzEvent(decision, policy, { now = Math.floor(Date.now() / 1000) } = {}) {
  assertPolicyDecision(decision); projectionPolicy(policy)
  if (!['quarantine_header', 'released_post'].includes(decision.template) || !UUID.test(String(decision.dest || ''))) fail('decision is not a closed policy destination')
  const content = decision.template === 'quarantine_header'
    ? renderQuarantineHeader(decision.slots)
    : renderReleased(decision.slots)
  return Object.freeze({ kind: 9, created_at: timestamp(now), content,
    tags: Object.freeze([Object.freeze(['h', decision.dest]), policy.authTag]), pubkey: policy.posterPubkey })
}

export function unsignedEventSha256(unsigned, policy) {
  projectionPolicy(policy)
  const expected = ['content', 'created_at', 'kind', 'pubkey', 'tags']
  if (!unsigned || Object.keys(unsigned).sort().join(',') !== expected.sort().join(',') ||
      unsigned.pubkey !== policy.posterPubkey || unsigned.kind !== 9 || !Array.isArray(unsigned.tags) ||
      typeof unsigned.content !== 'string') fail('unsigned event is not an exact policy projection')
  const preimage = canonicalJson([0, unsigned.pubkey, timestamp(unsigned.created_at), unsigned.kind, unsigned.tags, unsigned.content])
  return createHash('sha256').update(preimage).digest('hex')
}
