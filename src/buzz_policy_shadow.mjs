// Derive-only comparison boundary. It accepts the same canonical evidence packet as the live
// policy service, chooses evaluation time locally, and returns no event or signing artifact.
import { createHash } from 'node:crypto'
import { canonicalJson, decodePolicyRequest, decideQuarantineHeader, decideStandingTrustedReply } from './buzz_policy_core.mjs'
import { buildBuzzEvent, unsignedEventSha256 } from './buzz_policy_projection.mjs'

const fail = message => { throw new Error(`buzz-policy-shadow: ${message}`) }
const exactTime = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail('evaluation time is invalid')
  return value
}

export function deriveBuzzPolicyShadow(raw, {
  policyInstance, catalogueVersion, stagingChannel, inboxChannel, watchedEventIds, trustedRepliers = [], approverMention = '',
  projectionPolicy, now = Math.floor(Date.now() / 1000),
} = {}) {
  const evaluationTime = exactTime(now)
  const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now: evaluationTime })
  const requestDigest = createHash('sha256').update(raw).digest('hex')
  let decision
  try {
    decision = request.operation === 'quarantine_header'
      ? decideQuarantineHeader(request, { stagingChannel, watchedEventIds, approverMention })
      : decideStandingTrustedReply(request, { inboxChannel, watchedEventIds, trustedRepliers })
  }
  catch {
    return Object.freeze({ v: 1, request_digest: requestDigest, policy_instance: policyInstance,
      catalogue_version: catalogueVersion, decision: 'deny', evaluation_time: evaluationTime,
      unsigned_event_sha256: null })
  }
  const unsigned = buildBuzzEvent(decision, projectionPolicy, { now: evaluationTime })
  return Object.freeze({ v: 1, request_digest: requestDigest, policy_instance: policyInstance,
    catalogue_version: catalogueVersion, decision: 'allow', evaluation_time: evaluationTime,
    unsigned_event_sha256: unsignedEventSha256(unsigned, projectionPolicy) })
}

export const encodeBuzzPolicyShadow = (raw, options) => `${canonicalJson(deriveBuzzPolicyShadow(raw, options))}\n`
