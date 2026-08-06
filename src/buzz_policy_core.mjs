// buzz_policy_core.mjs — pure, credential-free policy verification for the off-box
// Buzz writer (#54).  The bridge supplies evidence; this module independently decides
// whether the evidence can name one closed catalogue operation.  It never signs, submits,
// accepts rendered prose, or accepts a caller-selected destination.
import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'

export const BUZZ_POLICY_VERSION = 1
export const BUZZ_POLICY_OPERATIONS = Object.freeze(['quarantine_header', 'standing_trusted_reply', 'sealed_direct_envelope'])
const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const EVENT_KEYS = new Set(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
// ECMAScript Date's TimeClip boundary is ±8.64e15 milliseconds. Quarantine rendering
// intentionally preserves the source timestamp, so refuse signed-but-unrenderable seconds at
// policy admission rather than letting catalogue rendering throw after a decision is minted.
const MAX_RENDERABLE_UNIX_SECONDS = 8_640_000_000_000
const REQUEST_KEYS = new Set(['version', 'policy_instance', 'operation', 'catalogue_version', 'observed_at', 'evidence'])
const EVIDENCE_KEYS = Object.freeze({
  quarantine_header: new Set(['source_event']),
  standing_trusted_reply: new Set(['source_event']),
  sealed_direct_envelope: new Set(['source_event']),
})
const POLICY_REQUESTS = new WeakSet()
const POLICY_DECISIONS = new WeakSet()
const DECISION_REQUESTS = new WeakMap()

const fail = message => { throw new Error(`buzz-policy: ${message}`) }
const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).filter(key => !allowed.has(key))
  if (unknown.length) fail(`${label} contains unknown field ${JSON.stringify(unknown[0])}`)
  const missing = [...allowed].filter(key => !(key in value))
  if (missing.length) fail(`${label} is missing ${JSON.stringify(missing[0])}`)
}

// Canonical bytes are the request and idempotency boundary. Re-encoding also rejects duplicate
// JSON keys: JSON.parse keeps one duplicate, so the source bytes cannot match this representation.
export function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail('canonical JSON requires safe integers')
    return String(value)
  }
  if (!value || typeof value !== 'object') fail('canonical JSON refuses non-JSON value')
  if (seen.has(value)) fail('canonical JSON refuses cycles')
  seen.add(value)
  const result = Array.isArray(value)
    ? `[${value.map(item => canonicalJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`
  seen.delete(value)
  return result
}

function verifyWireEvent(event, expectedKind = 1) {
  exactKeys(event, EVENT_KEYS, 'source_event')
  if (!HEX64.test(String(event.id || '')) || !HEX64.test(String(event.pubkey || '')) ||
      !/^[0-9a-f]{128}$/.test(String(event.sig || '')) || !Number.isSafeInteger(event.created_at) ||
      event.created_at < 0 || event.created_at > MAX_RENDERABLE_UNIX_SECONDS ||
      event.kind !== expectedKind || !Array.isArray(event.tags) ||
      typeof event.content !== 'string') fail(`source_event is not a complete kind:${expectedKind} wire event`)
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
  if (!ID.test(String(policyInstance || ''))) fail('policy_instance is invalid')
  if (!HEX64.test(String(catalogueVersion || ''))) fail('catalogue_version is invalid')
  if (typeof raw !== 'string') fail('request must be canonical JSON text')
  if (!raw || Buffer.byteLength(raw) > maxBytes) fail(`request exceeds ${maxBytes} bytes`)
  let request
  try { request = JSON.parse(raw) } catch { fail('request is not JSON') }
  if (canonicalJson(request) !== raw) fail('request is not canonical JSON')
  exactKeys(request, REQUEST_KEYS, 'request')
  if (request.version !== BUZZ_POLICY_VERSION) fail('unsupported protocol version')
  if (request.policy_instance !== policyInstance) fail('policy_instance does not match this service')
  if (request.catalogue_version !== catalogueVersion) fail('catalogue_version does not match this service')
  if (!BUZZ_POLICY_OPERATIONS.includes(request.operation)) fail('unsupported operation')
  if (!Number.isSafeInteger(request.observed_at) || request.observed_at < now - maxObservationAge || request.observed_at > now + maxFutureSkew) fail('observed_at is outside the freshness window')
  exactKeys(request.evidence, EVIDENCE_KEYS[request.operation], 'evidence')
  verifyWireEvent(request.evidence.source_event, request.operation === 'sealed_direct_envelope' ? 1059 : 1)
  Object.freeze(request)
  POLICY_REQUESTS.add(request)
  return request
}

const channel = value => {
  const text = String(value || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) fail('policy destination is not a channel UUID')
  return text
}

// The local bridge and off-box policy must derive the quarantine body from one implementation.
// Only the complete signed source may choose participant-visible bytes: no relay-selected kind:0,
// local clock clamp, or host-supplied display name can make shadow outputs diverge.
export function quarantineSlotsFromSource(sourceEvent, { approverMention = '' } = {}) {
  const source = verifyWireEvent(JSON.parse(JSON.stringify(sourceEvent)))
  return Object.freeze({
    body: source.content,
    approver: approverMention || undefined,
    name: undefined,
    npub: npubEncode(source.pubkey),
    ts: source.created_at,
    claimedTs: undefined,
    why: 'reply to our note',
    id: source.id,
  })
}

// Standing reply-trust deliberately carries less authority than feed mirroring or admission.
// Attribution is source-only: a mutable kind:0 profile selected by a relay cannot alter bytes
// signed by the policy host, and the lane never earns live references.
export function standingReplySlotsFromSource(sourceEvent) {
  const source = verifyWireEvent(JSON.parse(JSON.stringify(sourceEvent)))
  const npub = npubEncode(source.pubkey)
  return Object.freeze({
    body: source.content,
    name: undefined,
    npubShort: `${npub.slice(0, 10)}…${npub.slice(-5)}`,
    liveRefs: false,
  })
}

export function sealedDirectSlotsFromSource(sourceEvent, { recipientName } = {}) {
  const source = verifyWireEvent(JSON.parse(JSON.stringify(sourceEvent)), 1059)
  if (typeof recipientName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$/.test(recipientName)) fail('recipient name is invalid')
  return Object.freeze({ name: recipientName, channel: undefined, wrapJson: canonicalJson(source) })
}

// First operation family: a signed public reply to one of the policy service's own watched
// event ids.  The requester cannot pick the route, state, display name, body, or attribution;
// all are derived from the complete signed source and policy-owned state.
export function decideQuarantineHeader(request, { stagingChannel, watchedEventIds = [], approverMention = '' } = {}) {
  if (!request || !POLICY_REQUESTS.has(request)) fail('an internally verified policy request is required')
  if (request.operation !== 'quarantine_header') fail('wrong operation for quarantine decision')
  const source = request.evidence.source_event
  const watched = new Set(watchedEventIds.map(value => String(value).toLowerCase()).filter(value => HEX64.test(value)))
  const replyTargets = source.tags.filter(tag => tag[0] === 'e' && HEX64.test(String(tag[1] || '').toLowerCase())).map(tag => tag[1].toLowerCase())
  if (!replyTargets.some(id => watched.has(id))) fail('source_event is not a reply to a policy-watched event')
  const decision = Object.freeze({
    template: 'quarantine_header',
    dest: channel(stagingChannel),
    slots: quarantineSlotsFromSource(source, { approverMention }),
  })
  POLICY_DECISIONS.add(decision)
  DECISION_REQUESTS.set(decision, request)
  return decision
}

// A standing trusted replier may enter the hive only when this exact signed note replies to a
// policy-owned live reference. The bridge cannot assert either fact: both sets live here and the
// signed event supplies the author and e-tags. This is intentionally NOT the mirrored-feed lane.
export function decideStandingTrustedReply(request, { inboxChannel, watchedEventIds = [], trustedRepliers = [] } = {}) {
  if (!request || !POLICY_REQUESTS.has(request)) fail('an internally verified policy request is required')
  if (request.operation !== 'standing_trusted_reply') fail('wrong operation for standing reply decision')
  const source = request.evidence.source_event
  const trusted = new Set(trustedRepliers.map(value => String(value).toLowerCase()).filter(value => HEX64.test(value)))
  if (!trusted.has(source.pubkey)) fail('source author is not a policy-trusted replier')
  const watched = new Set(watchedEventIds.map(value => String(value).toLowerCase()).filter(value => HEX64.test(value)))
  const replyTargets = source.tags.filter(tag => tag[0] === 'e' && HEX64.test(String(tag[1] || '').toLowerCase())).map(tag => tag[1].toLowerCase())
  if (!replyTargets.some(id => watched.has(id))) fail('source_event is not a reply to a policy-watched event')
  const decision = Object.freeze({
    template: 'released_post',
    dest: channel(inboxChannel),
    slots: standingReplySlotsFromSource(source),
  })
  POLICY_DECISIONS.add(decision)
  DECISION_REQUESTS.set(decision, request)
  return decision
}

// A direct NIP-59 gift wrap names exactly one recipient in its signed outer p-tag. The policy
// host, not the bridge, maps that identity to a fixed Buzz inbox and display handle. Channel-plane
// wraps are deliberately outside this operation: their p-tag is a decoy and they route by author.
export function decideSealedDirectEnvelope(request, { recipientRoutes = {} } = {}) {
  if (!request || !POLICY_REQUESTS.has(request)) fail('an internally verified policy request is required')
  if (request.operation !== 'sealed_direct_envelope') fail('wrong operation for sealed direct decision')
  const source = request.evidence.source_event
  const recipients = source.tags.filter(tag => tag[0] === 'p' && tag.length === 2 && HEX64.test(String(tag[1] || '').toLowerCase()))
  if (recipients.length !== 1) fail('direct gift wrap must name exactly one recipient')
  const recipient = recipients[0][1].toLowerCase()
  const route = recipientRoutes && recipientRoutes[recipient]
  if (!route || typeof route !== 'object' || Array.isArray(route)) fail('recipient is not in the policy roster')
  const decision = Object.freeze({
    template: 'sealed_envelope',
    dest: channel(route.inbox),
    slots: sealedDirectSlotsFromSource(source, { recipientName: route.name }),
  })
  POLICY_DECISIONS.add(decision)
  DECISION_REQUESTS.set(decision, request)
  return decision
}

// Artifact construction is a separate trust boundary.  A shape-compatible object from
// the bridge is not a decision: only an object minted by the policy evaluator is.
export function assertPolicyDecision(decision) {
  if (!decision || !POLICY_DECISIONS.has(decision)) fail('an internally derived policy decision is required')
  return decision
}

export function policyIdempotencyKey(request, decision) {
  assertPolicyDecision(decision)
  if (!request || !POLICY_REQUESTS.has(request) || DECISION_REQUESTS.get(decision) !== request) fail('the decision is not bound to this verified request')
  const sourceIds = [request.evidence.source_event.id]
  return createHash('sha256').update(canonicalJson([
    request.version, request.policy_instance, request.catalogue_version,
    request.operation, sourceIds, decision.dest,
  ])).digest('hex')
}
