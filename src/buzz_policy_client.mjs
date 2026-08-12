// Credential-free bridge edge for the off-box Buzz policy service (#54).
// It constructs evidence-only requests and accepts completion only from a
// signature-verified receipt bound to those exact request bytes.
import { createHash } from 'node:crypto'
import { verifyEvent } from 'nostr-tools/pure'
import { canonicalJson } from './buzz_policy_core.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/
const EVENT_KEYS = new Set(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
const REQUEST_KEYS = new Set(['version', 'policy_instance', 'operation', 'catalogue_version', 'observed_at', 'evidence'])
const EVIDENCE_KEYS = Object.freeze({
  quarantine_header: new Set(['source_event']), standing_trusted_reply: new Set(['source_event']),
  sealed_direct_envelope: new Set(['source_event']), withdraw_repost: new Set(['source_event', 'deletion_event', 'prior_receipt']),
})
const RESPONSE_KEYS = new Set(['status', 'result', 'receipt'])
const RECEIPT_KEYS = new Set(['version', 'policy_instance', 'operation', 'catalogue_version', 'request_digest',
  'idempotency_key', 'source_ids', 'buzz_channel', 'endpoint_authority', 'buzz_event_id', 'result',
  'reason_code', 'response_digest', 'completed_at'])
const fail = message => { throw new Error(`buzz-policy-client: ${message}`) }
export const LEGACY_POLICY_OPERATIONS = Object.freeze(['quarantine_header', 'standing_trusted_reply'])
const POLICY_OPERATIONS = new Set([...LEGACY_POLICY_OPERATIONS, 'sealed_direct_envelope', 'withdraw_repost'])
export function normalizePolicyOperations(value, label = 'policy') {
  const operations = value == null ? [...LEGACY_POLICY_OPERATIONS] : value
  if (!Array.isArray(operations) || !operations.length || operations.some(operation => !POLICY_OPERATIONS.has(operation)) ||
      new Set(operations).size !== operations.length) fail(`${label}.operations must be a unique non-empty closed operation list`)
  return Object.freeze([...operations])
}
const exactKeys = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) fail(`${label} contains unknown field ${JSON.stringify(unknown)}`)
  const missing = [...allowed].find(key => !(key in value))
  if (missing) fail(`${label} is missing ${JSON.stringify(missing)}`)
}
const parseCanonical = (raw, label, maxBytes) => {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > maxBytes) fail(`${label} is empty or oversized`)
  let value
  try { value = JSON.parse(raw) } catch { fail(`${label} is not JSON`) }
  if (canonicalJson(value) !== raw) fail(`${label} is not canonical JSON`)
  return value
}
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const verifySourceEvent = (event, expectedKind = 1) => {
  exactKeys(event, EVENT_KEYS, 'source_event')
  if (!HEX64.test(String(event.id || '')) || !HEX64.test(String(event.pubkey || '')) ||
      !HEX128.test(String(event.sig || '')) || !Number.isSafeInteger(event.created_at) || event.created_at < 0 ||
      event.kind !== expectedKind || !Array.isArray(event.tags) || typeof event.content !== 'string' ||
      !event.tags.every(tag => Array.isArray(tag) && tag.every(value => typeof value === 'string'))) fail(`source_event is not a complete kind:${expectedKind} wire event`)
  let verified = false
  try { verified = verifyEvent(JSON.parse(JSON.stringify(event))) } catch { verified = false }
  if (!verified) fail('source_event signature or id is invalid')
  return event
}
const verifyRequestShape = request => {
  exactKeys(request, REQUEST_KEYS, 'request')
  if (request.version !== 1 || !POLICY_OPERATIONS.has(request.operation) || !ID.test(String(request.policy_instance || '')) ||
      !HEX64.test(String(request.catalogue_version || '')) || !Number.isSafeInteger(request.observed_at) || request.observed_at < 0) fail('request binding is invalid')
  exactKeys(request.evidence, EVIDENCE_KEYS[request.operation], 'evidence')
  verifySourceEvent(request.evidence.source_event, request.operation === 'sealed_direct_envelope' ? 1059 : 1)
  if (request.operation === 'withdraw_repost') {
    verifySourceEvent(request.evidence.deletion_event, 5)
    verifySourceEvent(request.evidence.prior_receipt, 30078)
  }
  return request
}

const requestSourceIds = request => request.operation === 'withdraw_repost'
  ? [request.evidence.source_event.id, request.evidence.deletion_event.id, request.evidence.prior_receipt.id]
  : [request.evidence.source_event.id]

export function validatePolicyWriterConfig(config) {
  if (!config || config.mode !== 'remote-only' || !ID.test(String(config.policyInstance || '')) ||
      !HEX64.test(String(config.catalogueVersion || '')) || !HEX64.test(String(config.posterPubkey || '')) ||
      typeof config.endpointAuthority !== 'string' || !config.endpointAuthority || config.endpointAuthority.length > 255 ||
      /[\s/]/.test(config.endpointAuthority) || !HOST.test(String(config.host || '')) || !USER.test(String(config.user || '')) ||
      typeof config.identityFile !== 'string' || !config.identityFile.startsWith('/') ||
      typeof config.knownHostsFile !== 'string' || !config.knownHostsFile.startsWith('/')) fail('policy writer configuration is invalid')
  return config
}

export function buildQuarantinePolicyRequest(sourceEvent, {
  policyInstance, catalogueVersion, observedAt = Math.floor(Date.now() / 1000),
} = {}) {
  if (!ID.test(String(policyInstance || '')) || !HEX64.test(String(catalogueVersion || ''))) fail('policy identity is invalid')
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('observed_at is invalid')
  verifySourceEvent(sourceEvent)
  return canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'quarantine_header',
    catalogue_version: catalogueVersion, observed_at: observedAt,
    evidence: { source_event: JSON.parse(JSON.stringify(sourceEvent)) } })
}

export function buildStandingTrustedReplyPolicyRequest(sourceEvent, {
  policyInstance, catalogueVersion, observedAt = Math.floor(Date.now() / 1000),
} = {}) {
  if (!ID.test(String(policyInstance || '')) || !HEX64.test(String(catalogueVersion || ''))) fail('policy identity is invalid')
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('observed_at is invalid')
  verifySourceEvent(sourceEvent)
  return canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'standing_trusted_reply',
    catalogue_version: catalogueVersion, observed_at: observedAt,
    evidence: { source_event: JSON.parse(JSON.stringify(sourceEvent)) } })
}

export function buildSealedDirectPolicyRequest(sourceEvent, {
  policyInstance, catalogueVersion, observedAt = Math.floor(Date.now() / 1000),
} = {}) {
  if (!ID.test(String(policyInstance || '')) || !HEX64.test(String(catalogueVersion || ''))) fail('policy identity is invalid')
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('observed_at is invalid')
  verifySourceEvent(sourceEvent, 1059)
  return canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'sealed_direct_envelope',
    catalogue_version: catalogueVersion, observed_at: observedAt,
    evidence: { source_event: JSON.parse(JSON.stringify(sourceEvent)) } })
}

export function buildWithdrawRepostPolicyRequest(sourceEvent, deletionEvent, priorReceipt, {
  policyInstance, catalogueVersion, observedAt = Math.floor(Date.now() / 1000),
} = {}) {
  if (!ID.test(String(policyInstance || '')) || !HEX64.test(String(catalogueVersion || ''))) fail('policy identity is invalid')
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('observed_at is invalid')
  verifySourceEvent(sourceEvent, 1); verifySourceEvent(deletionEvent, 5); verifySourceEvent(priorReceipt, 30078)
  return canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'withdraw_repost',
    catalogue_version: catalogueVersion, observed_at: observedAt,
    evidence: { source_event: JSON.parse(JSON.stringify(sourceEvent)), deletion_event: JSON.parse(JSON.stringify(deletionEvent)),
      prior_receipt: JSON.parse(JSON.stringify(priorReceipt)) } })
}

export function policyRequestQueueKey(requestRaw) {
  const request = parseCanonical(requestRaw, 'request', 128 * 1024)
  verifyRequestShape(request)
  return request.operation === 'withdraw_repost'
    ? createHash('sha256').update(canonicalJson([request.evidence.deletion_event.id, request.evidence.source_event.id])).digest('hex')
    : request.evidence.source_event.id
}

export function verifyPolicyResponse(raw, {
  requestRaw, posterPubkey, expectedChannel, endpointAuthority, maxBytes = 256 * 1024,
} = {}) {
  if (!HEX64.test(String(posterPubkey || '')) || !UUID.test(String(expectedChannel || '')) ||
      typeof endpointAuthority !== 'string' || !endpointAuthority || endpointAuthority.length > 255) fail('expected policy binding is invalid')
  const request = parseCanonical(requestRaw, 'request', 128 * 1024)
  verifyRequestShape(request)
  const sourceIds = requestSourceIds(request)
  const response = parseCanonical(raw, 'response', maxBytes)
  exactKeys(response, RESPONSE_KEYS, 'response')
  if (['held', 'ambiguous', 'recoverable'].includes(response.status)) {
    if (response.result !== null || response.receipt !== null) fail('a non-terminal response cannot claim a result or receipt')
    return Object.freeze({ terminal: false, status: response.status, result: null, buzzEventId: null, receipt: null })
  }
  if (response.status !== 'terminal' || !['accepted', 'rejected', 'ambiguous'].includes(response.result) || typeof response.receipt !== 'string') fail('terminal response shape is invalid')
  const event = parseCanonical(response.receipt, 'signed receipt', maxBytes)
  exactKeys(event, new Set(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig']), 'signed receipt')
  if (!HEX64.test(String(event.id || '')) || event.pubkey !== posterPubkey || !HEX128.test(String(event.sig || '')) ||
      event.kind !== 30078 || !Number.isSafeInteger(event.created_at) || !Array.isArray(event.tags) || typeof event.content !== 'string') fail('signed receipt envelope is invalid')
  let verified = false
  try { verified = verifyEvent(JSON.parse(JSON.stringify(event))) } catch { verified = false }
  if (!verified) fail('signed receipt signature or id is invalid')
  const fields = parseCanonical(event.content, 'receipt content', maxBytes)
  exactKeys(fields, RECEIPT_KEYS, 'receipt content')
  const requestDigest = createHash('sha256').update(requestRaw).digest('hex')
  const expectedKey = createHash('sha256').update(canonicalJson([request.version, request.policy_instance,
    request.catalogue_version, request.operation, sourceIds, expectedChannel])).digest('hex')
  if (fields.version !== request.version || fields.policy_instance !== request.policy_instance ||
      fields.operation !== request.operation || fields.catalogue_version !== request.catalogue_version ||
      fields.request_digest !== requestDigest || fields.idempotency_key !== expectedKey ||
      !same(fields.source_ids, sourceIds) || fields.buzz_channel !== expectedChannel ||
      fields.endpoint_authority !== endpointAuthority || fields.result !== response.result ||
      !HEX64.test(String(fields.response_digest || '')) || !Number.isSafeInteger(fields.completed_at) ||
      fields.completed_at !== event.created_at) fail('signed receipt is not bound to this request and policy')
  const expectedReason = { accepted: 'accepted', rejected: 'relay_refused', ambiguous: 'signing_outcome_unknown' }[fields.result]
  if (fields.reason_code !== expectedReason) fail('signed receipt outcome is invalid')
  if (fields.result === 'ambiguous') {
    if (fields.buzz_event_id !== null) fail('ambiguous receipt cannot claim a Buzz event id')
  } else if (!HEX64.test(String(fields.buzz_event_id || ''))) fail('terminal receipt has no valid Buzz event id')
  if (event.tags.length !== 1 || event.tags[0]?.length !== 2 || event.tags[0][0] !== 'd' ||
      event.tags[0][1] !== `waggle-policy:${expectedKey}`) fail('signed receipt address is not bound to idempotency')
  return Object.freeze({ terminal: true, status: 'terminal', result: fields.result,
    buzzEventId: fields.buzz_event_id, receipt: Object.freeze(event) })
}
