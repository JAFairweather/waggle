// Policy-owned Buzz event, NIP-98 authorization, and receipt construction for the
// off-box writer. The caller supplies evidence only; every authored byte is derived
// here and every signer result is verified exactly.
import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { assertPolicyDecision, canonicalJson } from './buzz_policy_core.mjs'
import { buildBuzzEvent as projectBuzzEvent, createProjectionPolicy } from './buzz_policy_projection.mjs'

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
const submitFailure = (message, outcome, responseDigest = '') => Object.assign(new Error(`buzz-policy-artifact: ${message}`), { outcome, responseDigest })

export function createArtifactPolicy({ posterPubkey, authTag, endpoint, timeoutMs = 15_000, maxResponseBytes = 64 * 1024, nip98MaxAgeSec = 60 } = {}) {
  let projection
  try { projection = createProjectionPolicy({ posterPubkey, authTag }) }
  catch (error) { fail(String(error?.message || 'projection policy is invalid').replace(/^buzz-policy-projection: /, '')) }
  let url; try { url = new URL(String(endpoint || '')) } catch { fail('endpoint is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/events') fail('endpoint must be the fixed HTTPS origin /events URL')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) fail('timeoutMs is outside the policy bounds')
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1_024 || maxResponseBytes > 256 * 1024) fail('maxResponseBytes is outside the policy bounds')
  if (!Number.isSafeInteger(nip98MaxAgeSec) || nip98MaxAgeSec < 5 || nip98MaxAgeSec > 300) fail('nip98MaxAgeSec is outside the policy bounds')
  const policy = Object.freeze({ posterPubkey: projection.posterPubkey, authTag: projection.authTag, projection,
    endpoint: url.toString(), endpointAuthority: url.host, timeoutMs, maxResponseBytes, nip98MaxAgeSec })
  ARTIFACT_POLICIES.add(policy)
  return policy
}

const artifactPolicy = policy => {
  if (!policy || !ARTIFACT_POLICIES.has(policy)) fail('an internally configured artifact policy is required')
  return policy
}

export function buildBuzzEvent(decision, policy, { now = Math.floor(Date.now() / 1000) } = {}) {
  artifactPolicy(policy)
  return projectBuzzEvent(decision, policy.projection, { now })
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

// Recovery must prove that durable bytes are the exact event this policy would
// have authored.  Signature validity alone is insufficient: a valid signer may
// have produced another destination, template, or authorization tag.
export function verifySignedBuzzEvent(event, decision, policy) {
  assertPolicyDecision(decision); artifactPolicy(policy)
  const signed = exactWireEvent(wire(event), 'signed Buzz event')
  const expected = buildBuzzEvent(decision, policy, { now: signed.created_at })
  const projected = { kind: signed.kind, created_at: signed.created_at, content: signed.content, tags: signed.tags, pubkey: signed.pubkey }
  if (!same(projected, expected)) fail('prepared Buzz event does not match policy-owned bytes')
  return Object.freeze(signed)
}

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

const tagValue = (event, name) => {
  const matches = event.tags.filter(tag => tag[0] === name)
  if (matches.length !== 1 || matches[0].length !== 2) fail(`signed NIP-98 event has invalid ${name} binding`)
  return matches[0][1]
}

async function boundedResponseBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) fail('Buzz response exceeds the policy limit')
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) fail('Buzz response exceeds the policy limit')
    return bytes
  }
  const reader = response.body.getReader(), chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); fail('Buzz response exceeds the policy limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

// The reusable credentials never cross this call boundary. The policy service verifies
// their exact bindings, submits them itself, and returns only a bounded outcome digest.
export async function submitBuzzEvent(signedBuzzEvent, signedNip98, policy, {
  fetchImpl = globalThis.fetch, now = Math.floor(Date.now() / 1000),
} = {}) {
  exactWireEvent(signedBuzzEvent, 'signed Buzz event'); exactWireEvent(signedNip98, 'signed NIP-98 event'); artifactPolicy(policy)
  if (signedBuzzEvent.pubkey !== policy.posterPubkey || signedNip98.pubkey !== policy.posterPubkey || signedNip98.kind !== 27235 || signedNip98.content !== '') fail('signed submission identity is invalid')
  timestamp(now)
  if (Math.abs(now - signedNip98.created_at) > policy.nip98MaxAgeSec) fail('signed NIP-98 event is outside the freshness window')
  const eventAuth = signedBuzzEvent.tags.filter(tag => tag[0] === 'auth')
  if (eventAuth.length !== 1 || !same(eventAuth[0], policy.authTag)) fail('signed Buzz event does not carry the configured owner attestation')
  const body = canonicalJson(signedBuzzEvent), payload = createHash('sha256').update(body).digest('hex')
  if (signedNip98.tags.length !== 4 || tagValue(signedNip98, 'u') !== policy.endpoint ||
      tagValue(signedNip98, 'method') !== 'POST' || tagValue(signedNip98, 'payload') !== payload ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(tagValue(signedNip98, 'nonce'))) fail('signed NIP-98 event does not authorize this exact submission')
  if (typeof fetchImpl !== 'function') fail('HTTPS submitter is unavailable')
  let response
  try {
    response = await fetchImpl(policy.endpoint, { method: 'POST', redirect: 'manual', signal: globalThis.AbortSignal.timeout(policy.timeoutMs),
      headers: { authorization: `Nostr ${Buffer.from(JSON.stringify(signedNip98)).toString('base64')}`,
        'content-type': 'application/json', 'x-auth-tag': JSON.stringify(policy.authTag) }, body })
  } catch (error) {
    throw submitFailure(`Buzz submission did not reach an authoritative response: ${error?.name || 'network error'}`,
      'ambiguous', createHash('sha256').update(String(error?.name || 'network-error')).digest('hex'))
  }
  let bytes
  try { bytes = await boundedResponseBody(response, policy.maxResponseBytes) }
  catch (error) { throw submitFailure(String(error?.message || 'Buzz response could not be bounded'), 'ambiguous') }
  const responseDigest = createHash('sha256').update(bytes).digest('hex')
  if (response.status === 429 || response.status >= 500 || response.status < 200 || (response.status >= 300 && response.status < 400)) {
    throw submitFailure(`Buzz submission is retryable (HTTP ${response.status})`, 'held', responseDigest)
  }
  if (response.status >= 400) throw submitFailure(`Buzz response is not an authoritative exact-event outcome (HTTP ${response.status})`, 'ambiguous', responseDigest)
  let parsed
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw submitFailure('Buzz success response is not JSON', 'ambiguous', responseDigest) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).some(key => !['event_id', 'accepted', 'message'].includes(key)) ||
      parsed.event_id !== signedBuzzEvent.id || typeof parsed.accepted !== 'boolean' || typeof parsed.message !== 'string') throw submitFailure('Buzz success response has an invalid shape or event binding', 'ambiguous', responseDigest)
  return Object.freeze({ result: parsed.accepted ? 'accepted' : 'rejected', reasonCode: parsed.accepted ? 'accepted' : 'relay_refused', responseDigest, status: response.status })
}

export async function buildSignedReceipt(fields, signer, policy, { now = Math.floor(Date.now() / 1000) } = {}) {
  artifactPolicy(policy)
  const required = ['version', 'policy_instance', 'operation', 'catalogue_version', 'request_digest', 'idempotency_key',
    'source_ids', 'buzz_channel', 'endpoint_authority', 'buzz_event_id', 'result', 'reason_code', 'response_digest', 'completed_at']
  if (!fields || Object.keys(fields).sort().join(',') !== [...required].sort().join(',')) fail('receipt has an invalid shape')
  const outcomes = Object.freeze({ accepted: 'accepted', rejected: 'relay_refused', ambiguous: 'signing_outcome_unknown' })
  if (fields.version !== 1 || fields.operation !== 'quarantine_header' || outcomes[fields.result] !== fields.reason_code) fail('receipt outcome is invalid')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(fields.policy_instance || ''))) fail('policy_instance is invalid')
  for (const name of ['catalogue_version', 'request_digest', 'idempotency_key', 'response_digest']) hex(fields[name], name)
  if (fields.result === 'ambiguous') {
    if (fields.buzz_event_id !== null) fail('an ambiguous receipt cannot claim a Buzz event id')
  } else hex(fields.buzz_event_id, 'buzz_event_id')
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
