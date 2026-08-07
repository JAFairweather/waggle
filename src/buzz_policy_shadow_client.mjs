// Credential-free client/comparator for the derive-only #54 policy shadow. The remote side
// returns only a decision and unsigned-event digest. This side independently re-runs the pure
// projection at the shadow-owned evaluation time; no signer, receipt, endpoint, or event crosses
// this boundary.
import { createHash } from 'node:crypto'
import { canonicalJson, decodePolicyRequest, decideQuarantineHeader, decideStandingTrustedReply, decideSealedDirectEnvelope } from './buzz_policy_core.mjs'
import { buildBuzzEvent, createProjectionPolicy, unsignedEventSha256 } from './buzz_policy_projection.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/
const USER = /^[a-z_][a-z0-9_-]{0,31}$/
const RESPONSE_KEYS = new Set(['v', 'request_digest', 'policy_instance', 'catalogue_version',
  'decision', 'evaluation_time', 'unsigned_event_sha256'])
const fail = message => { throw new Error(`buzz-policy-shadow-client: ${message}`) }

export function validateShadowClientConfig({ policyInstance, catalogueVersion, posterPubkey, authTag,
  host, user = 'waggle-policy-shadow-ingress', identityFile, knownHostsFile } = {}) {
  if (!ID.test(String(policyInstance || '')) || !HEX64.test(String(catalogueVersion || '')) ||
      !HOST.test(String(host || '')) || !USER.test(String(user || '')) ||
      !String(identityFile || '').startsWith('/') || !String(knownHostsFile || '').startsWith('/')) fail('shadow configuration is invalid')
  createProjectionPolicy({ posterPubkey, authTag })
  return true
}

const exactKeys = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('response must be an object')
  const actual = Object.keys(value)
  const unknown = actual.find(key => !RESPONSE_KEYS.has(key))
  const missing = [...RESPONSE_KEYS].find(key => !(key in value))
  if (unknown) fail(`response contains unknown field ${JSON.stringify(unknown)}`)
  if (missing) fail(`response is missing ${JSON.stringify(missing)}`)
}

export function parseShadowResponse(raw, { requestRaw, policyInstance, catalogueVersion } = {}) {
  if (typeof raw !== 'string' || !raw.endsWith('\n') || raw.endsWith('\n\n') || Buffer.byteLength(raw) > 64 * 1024) fail('response is not one bounded canonical line')
  let response
  try { response = JSON.parse(raw.slice(0, -1)) } catch { fail('response is not JSON') }
  if (`${canonicalJson(response)}\n` !== raw) fail('response is not canonical JSON')
  exactKeys(response)
  let request
  try { request = JSON.parse(requestRaw) } catch { fail('bound request is not JSON') }
  const requestDigest = createHash('sha256').update(String(requestRaw || '')).digest('hex')
  if (response.v !== 1 || response.request_digest !== requestDigest ||
      response.policy_instance !== policyInstance || response.catalogue_version !== catalogueVersion ||
      !ID.test(String(response.policy_instance || '')) || !HEX64.test(String(response.catalogue_version || '')) ||
      !['allow', 'deny'].includes(response.decision) || !Number.isSafeInteger(response.evaluation_time) ||
      response.evaluation_time < 0) fail('response binding is invalid')
  // The shadow owns the exact evaluation instant, but not an arbitrary clock. This mirrors the
  // policy request's 300s age / 30s future-skew window and prevents a compromised or skewed shadow
  // from earning false burn-in credit with a far-past/future unsigned event.
  if (!Number.isSafeInteger(request?.observed_at) || response.evaluation_time < request.observed_at - 30 ||
      response.evaluation_time > request.observed_at + 300) fail('evaluation_time is outside the request freshness window')
  if (response.decision === 'allow' ? !HEX64.test(String(response.unsigned_event_sha256 || '')) : response.unsigned_event_sha256 !== null) fail('response decision/digest combination is invalid')
  return Object.freeze(response)
}

export function comparePolicyShadow(requestRaw, rawResponse, {
  policyInstance, catalogueVersion, stagingChannel, inboxChannel, watchedEventIds,
  trustedRepliers = [], recipientRoutes = {}, approverMention = '',
  posterPubkey, authTag,
} = {}) {
  const remote = parseShadowResponse(rawResponse, { requestRaw, policyInstance, catalogueVersion })
  const projectionPolicy = createProjectionPolicy({ posterPubkey, authTag })
  const request = decodePolicyRequest(requestRaw, {
    policyInstance, catalogueVersion, now: remote.evaluation_time,
  })
  let localDecision = 'deny', localDigest = null
  try {
    const decision = request.operation === 'quarantine_header'
      ? decideQuarantineHeader(request, { stagingChannel, watchedEventIds, approverMention })
      : request.operation === 'standing_trusted_reply'
        ? decideStandingTrustedReply(request, { inboxChannel, watchedEventIds, trustedRepliers })
        : decideSealedDirectEnvelope(request, { recipientRoutes })
    const unsigned = buildBuzzEvent(decision, projectionPolicy, { now: remote.evaluation_time })
    localDecision = 'allow'
    localDigest = unsignedEventSha256(unsigned, projectionPolicy)
  } catch { /* a policy denial is compared as a denial, never upgraded */ }
  const match = remote.decision === localDecision && remote.unsigned_event_sha256 === localDigest
  return Object.freeze({ match, decision: remote.decision, evaluationTime: remote.evaluation_time,
    remoteDigest: remote.unsigned_event_sha256, localDigest,
    reason: match ? 'match' : (remote.decision !== localDecision ? 'decision-mismatch' : 'digest-mismatch') })
}

// Compatibility name for callers/tests from the first policy family. It now compares any closed
// operation encoded in the bound request; no caller selects the evaluator independently.
export const compareQuarantineShadow = comparePolicyShadow
