// buzz_policy_core.mjs — pure, credential-free policy verification for the off-box
// Buzz writer (#54).  The bridge supplies evidence; this module independently decides
// whether the evidence can name one closed catalogue operation.  It never signs, submits,
// accepts rendered prose, or accepts a caller-selected destination.
import { verifyEvent } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { PROTOCOL_VERSION, canonicalJson, deriveIdempotencyKey, parseCanonicalPacket } from './policy_protocol.mjs'

export { canonicalJson }
export const BUZZ_POLICY_VERSION = PROTOCOL_VERSION
export const BUZZ_POLICY_OPERATIONS = Object.freeze(['quarantine_header'])
const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const EVENT_KEYS = new Set(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
const EVIDENCE_KEYS = Object.freeze({ quarantine_header: new Set(['source_event']) })

const fail = message => { throw new Error(`buzz-policy: ${message}`) }
const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) fail(`${label} contains unknown field ${JSON.stringify(unknown[0])}`)
  const missing = [...allowed].filter(key => !(key in value))
  if (missing.length) fail(`${label} is missing ${JSON.stringify(missing[0])}`)
}

function verifyWireEvent(event) {
  exactKeys(event, EVENT_KEYS, 'source_event')
  if (!HEX64.test(String(event.id || '')) || !HEX64.test(String(event.pubkey || '')) ||
      !/^[0-9a-f]{128}$/.test(String(event.sig || '')) || !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 || event.kind !== 1 || !Array.isArray(event.tags) ||
      typeof event.content !== 'string') fail('source_event is not a complete kind:1 wire event')
  if (!event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))) fail('source_event has malformed tags')
  let valid = false
  try { valid = verifyEvent(JSON.parse(JSON.stringify(event))) } catch { valid = false }
  if (!valid) fail('source_event signature or id is invalid')
  return event
}

export function decodePolicyRequest(raw, {
  policyInstance, catalogueVersion, maxBytes = 128 * 1024,
  now = Math.floor(Date.now() / 1000), maxObservationAge = 300, maxFutureSkew = 30,
} = {}) {
  let request
  if (!ID.test(String(policyInstance || ''))) fail('policy_instance is invalid')
  if (!HEX64.test(String(catalogueVersion || ''))) fail('catalogue_version is invalid')
  try { request = parseCanonicalPacket(raw, { policyInstance, catalogueVersion }, maxBytes) }
  catch (e) { fail(e.message) }
  if (!BUZZ_POLICY_OPERATIONS.includes(request.operation)) fail('unsupported operation')
  if (!Number.isSafeInteger(request.observed_at) || request.observed_at < now - maxObservationAge || request.observed_at > now + maxFutureSkew) fail('observed_at is outside the freshness window')
  exactKeys(request.evidence, EVIDENCE_KEYS[request.operation], 'evidence')
  verifyWireEvent(request.evidence.source_event)
  return Object.freeze(request)
}

const channel = value => {
  const text = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) fail('policy destination is not a channel UUID')
  return text
}

// First operation family: a signed public reply to one of the policy service's own watched
// event ids.  The requester cannot pick the route, state, display name, body, or attribution;
// all are derived from the complete signed source and policy-owned state.
export function decideQuarantineHeader(request, { stagingChannel, watchedEventIds = [], approverMention = '' } = {}) {
  if (request?.operation !== 'quarantine_header') fail('wrong operation for quarantine decision')
  const source = request.evidence.source_event
  const watched = new Set(watchedEventIds.map(value => String(value).toLowerCase()).filter(value => HEX64.test(value)))
  const replyTargets = source.tags.filter(tag => tag[0] === 'e' && HEX64.test(String(tag[1] || '').toLowerCase())).map(tag => tag[1].toLowerCase())
  if (!replyTargets.some(id => watched.has(id))) fail('source_event is not a reply to a policy-watched event')
  return Object.freeze({
    template: 'quarantine_header',
    dest: channel(stagingChannel),
    slots: Object.freeze({
      body: source.content,
      approver: approverMention || undefined,
      name: undefined,
      npub: npubEncode(source.pubkey),
      ts: source.created_at,
      claimedTs: undefined,
      why: 'reply to our note',
      id: source.id,
    }),
  })
}

export function policyIdempotencyKey(request, decision) {
  if (!request || !decision) fail('request and decision are required')
  const sourceIds = [request.evidence.source_event.id]
  return deriveIdempotencyKey({ packet: request, sourceIds, destination: decision.dest })
}
