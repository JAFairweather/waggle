// Policy-owned Buzz event, NIP-98 authorization, and receipt construction for the
// off-box writer. The caller supplies evidence only; every authored byte is derived
// here and every signer result is verified exactly.
import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { assertPolicyDecision, canonicalJson } from './buzz_policy_core.mjs'
import { renderTemplate } from './egress.mjs'

const HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const fail = message => { throw new Error(`buzz-policy-artifact: ${message}`) }
const hex = (value, label, pattern = HEX64) => {
  const text = String(value || '').toLowerCase()
  if (!pattern.test(text)) fail(`${label} is invalid`)
  return text
}
const timestamp = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('timestamp is invalid')
  return value
}
const wire = event => JSON.parse(JSON.stringify(event))
const exactWireEvent = (event, label) => {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      Object.keys(event).sort().join(',') !== 'content,created_at,id,kind,pubkey,sig,tags') fail(`${label} is not an exact wire event`)
  hex(event.id, `${label}.id`); hex(event.pubkey, `${label}.pubkey`); hex(event.sig, `${label}.sig`, HEX128)
  timestamp(event.created_at)
  if (!Number.isSafeInteger(event.kind) || !Array.isArray(event.tags) || typeof event.content !== 'string' ||
      !event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))) fail(`${label} is malformed`)
  let valid = false; try { valid = verifyEvent(wire(event)) } catch { valid = false }
  if (!valid) fail(`${label} signature or id is invalid`)
  return event
}
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const ARTIFACT_POLICIES = new WeakSet()

export function createArtifactPolicy({ posterPubkey, authTag, endpoint } = {}) {
  const poster = hex(posterPubkey, 'posterPubkey')
  if (!Array.isArray(authTag) || authTag.length !== 4 || authTag[0] !== 'auth' || !authTag.every(value => typeof value === 'string')) fail('authTag must be the fixed four-field NIP-OA tag')
  const owner = hex(authTag[1], 'authTag owner'), signature = hex(authTag[3], 'authTag signature', HEX128)
  const attestation = sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${authTag[2]}`))
  if (!schnorr.verify(hexToBytes(signature), attestation, hexToBytes(owner))) fail('authTag owner signature is invalid for this poster')
  let url; try { url = new URL(String(endpoint || '')) } catch { fail('endpoint is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/events') fail('endpoint must be the fixed HTTPS origin /events URL')
  const policy = Object.freeze({ posterPubkey: poster, authTag: Object.freeze([...authTag]), endpoint: url.toString(), endpointAuthority: url.host })
  ARTIFACT_POLICIES.add(policy)
  return policy
}

const artifactPolicy = policy => {
  if (!policy || !ARTIFACT_POLICIES.has(policy)) fail('an internally configured artifact policy is required')
  return policy
}

export function buildBuzzEvent(decision, policy, { now = Math.floor(Date.now() / 1000) } = {}) {
  assertPolicyDecision(decision); artifactPolicy(policy)
  if (decision.template !== 'quarantine_header' || !UUID.test(String(decision.dest || ''))) fail('decision is not a closed quarantine destination')
  return Object.freeze({ kind: 9, created_at: timestamp(now), content: renderTemplate(decision.template, decision.slots),
    tags: Object.freeze([Object.freeze(['h', decision.dest]), policy.authTag]), pubkey: policy.posterPubkey })
}

async function signExact(unsigned, signer, label) {
  if (!signer || typeof signer.signEvent !== 'function') fail('signer is unavailable')
  const expected = wire(unsigned), signed = wire(await signer.signEvent(wire(unsigned)))
  exactWireEvent(signed, label)
  const projected = { kind: signed.kind, created_at: signed.created_at, content: signed.content, tags: signed.tags, pubkey: signed.pubkey }
  if (!same(projected, expected)) fail(`signer changed policy-owned ${label.replace(/^signed /, '')} bytes`)
  return Object.freeze(signed)
}

export const signExactBuzzEvent = (unsigned, signer) => signExact(unsigned, signer, 'signed Buzz event')

export function buildNip98Authorization(signedBuzzEvent, policy, { nonce, now = Math.floor(Date.now() / 1000) } = {}) {
  exactWireEvent(signedBuzzEvent, 'signed Buzz event')
  artifactPolicy(policy)
  if (signedBuzzEvent.pubkey !== policy.posterPubkey) fail('signed Buzz event is not from the configured poster')
  const nonceText = String(nonce || '')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonceText)) fail('nonce is invalid')
  const body = canonicalJson(signedBuzzEvent)
  return Object.freeze({ event: Object.freeze({ kind: 27235, created_at: timestamp(now), content: '', pubkey: signedBuzzEvent.pubkey,
    tags: Object.freeze([Object.freeze(['u', policy.endpoint]), Object.freeze(['method', 'POST']),
      Object.freeze(['payload', createHash('sha256').update(body).digest('hex')]), Object.freeze(['nonce', nonceText])]) }), body })
}

export const signExactNip98 = (unsigned, signer) => signExact(unsigned, signer, 'signed NIP-98 event')

export async function buildSignedReceipt(fields, signer, policy, { now = Math.floor(Date.now() / 1000) } = {}) {
  artifactPolicy(policy)
  const required = ['version', 'policy_instance', 'operation', 'catalogue_version', 'request_digest', 'idempotency_key',
    'source_ids', 'buzz_channel', 'endpoint_authority', 'buzz_event_id', 'result', 'reason_code', 'response_digest', 'completed_at']
  if (!fields || Object.keys(fields).sort().join(',') !== [...required].sort().join(',')) fail('receipt has an invalid shape')
  if (fields.version !== 1 || fields.operation !== 'quarantine_header' || fields.result !== 'accepted' || fields.reason_code !== 'accepted') fail('receipt outcome is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(fields.policy_instance || ''))) fail('policy_instance is invalid')
  for (const name of ['catalogue_version', 'request_digest', 'idempotency_key', 'buzz_event_id', 'response_digest']) hex(fields[name], name)
  if (!Array.isArray(fields.source_ids) || !fields.source_ids.length || !fields.source_ids.every(id => HEX64.test(String(id)))) fail('source_ids are invalid')
  if (!UUID.test(String(fields.buzz_channel || ''))) fail('buzz_channel is invalid')
  if (fields.endpoint_authority !== policy.endpointAuthority) fail('endpoint_authority is not policy-owned')
  timestamp(fields.completed_at)
  const content = canonicalJson(fields)
  const unsigned = { kind: 30078, created_at: timestamp(now), content, tags: [['d', `waggle-policy:${fields.idempotency_key}`]],
    pubkey: policy.posterPubkey }
  const signed = wire(await signer.signEvent(wire(unsigned)))
  exactWireEvent(signed, 'signed receipt')
  const projected = { kind: signed.kind, created_at: signed.created_at, content: signed.content, tags: signed.tags, pubkey: signed.pubkey }
  if (!same(projected, unsigned)) fail('signer changed policy-owned receipt bytes')
  return Object.freeze(signed)
}
