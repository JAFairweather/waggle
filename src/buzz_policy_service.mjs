// End-to-end off-box Buzz policy transaction.  The untrusted bridge contributes
// only canonical signed evidence.  This service independently decides, signs,
// durably prepares, submits, and returns only a signed receipt.
import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson, decodePolicyRequest, decideQuarantineHeader, policyIdempotencyKey } from './buzz_policy_core.mjs'
import { buildBuzzEvent, buildNip98Authorization, buildSignedReceipt, signExactBuzzEvent, signExactNip98, submitBuzzEvent, verifySignedBuzzEvent } from './buzz_policy_artifacts.mjs'

const fail = message => { throw new Error(`buzz-policy-service: ${message}`) }
const frozen = value => Object.freeze(value)

function preparedEvent(record, decision, artifactPolicy) {
  let event
  try { event = JSON.parse(record.buzz_event) } catch { fail('prepared Buzz event is not JSON') }
  if (canonicalJson(event) !== record.buzz_event) fail('prepared Buzz event is not canonical')
  if (event.id !== record.buzz_event_id) fail('prepared Buzz event id does not match the journal')
  return verifySignedBuzzEvent(event, decision, artifactPolicy)
}

function replay(record) {
  if (record.status === 'terminal') return frozen({ status: 'terminal', result: record.result === 'refused' ? 'rejected' : record.result, receipt: record.receipt })
  return frozen({ status: record.status === 'prepared' ? 'recoverable' : 'held', result: null, receipt: null })
}

function derive(raw, { policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention = '', now }) {
  const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now })
  const decision = decideQuarantineHeader(request, { stagingChannel, watchedEventIds, approverMention })
  const requestDigest = createHash('sha256').update(raw).digest('hex')
  return { request, decision, requestDigest, key: policyIdempotencyKey(request, decision) }
}

export async function processBuzzPolicyRequest(raw, {
  policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention = '',
  artifactPolicy, journal, signer, fetchImpl = fetch, now = Math.floor(Date.now() / 1000),
  nonce = () => randomBytes(24).toString('base64url'),
} = {}) {
  if (!journal || typeof journal.claim !== 'function' || typeof journal.prepare !== 'function' || typeof journal.commit !== 'function') fail('journal is unavailable')
  if (!signer || typeof signer.signEvent !== 'function') fail('signer is unavailable')
  const { request, decision, requestDigest, key } = derive(raw, { policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention, now })
  const claim = journal.claim(key, requestDigest, now)
  if (!claim.claimed && claim.record.status !== 'prepared') return replay(claim.record)

  let event
  if (claim.record.status === 'prepared') event = preparedEvent(claim.record, decision, artifactPolicy)
  else {
    const unsigned = buildBuzzEvent(decision, artifactPolicy, { now })
    event = await signExactBuzzEvent(unsigned, signer)
    const eventText = canonicalJson(event)
    const durable = journal.prepare(key, requestDigest, { buzzEvent: eventText, preparedAt: now })
    event = preparedEvent(durable, decision, artifactPolicy)
  }

  const authorization = buildNip98Authorization(event, artifactPolicy, { nonce: nonce(), now })
  const signedAuthorization = await signExactNip98(authorization.event, signer)
  let outcome
  try { outcome = await submitBuzzEvent(event, signedAuthorization, artifactPolicy, { fetchImpl, now }) }
  catch (error) {
    if (error?.outcome === 'held' || error?.outcome === 'ambiguous') return frozen({ status: error.outcome, result: null, receipt: null })
    throw error
  }

  const accepted = outcome.result === 'accepted'
  const receiptFields = {
    version: 1, policy_instance: policyInstance, operation: request.operation, catalogue_version: catalogueVersion,
    request_digest: requestDigest, idempotency_key: key, source_ids: [request.evidence.source_event.id],
    buzz_channel: decision.dest, endpoint_authority: artifactPolicy.endpointAuthority,
    buzz_event_id: event.id, result: outcome.result, reason_code: outcome.reasonCode,
    response_digest: outcome.responseDigest, completed_at: now,
  }
  const receiptEvent = await buildSignedReceipt(receiptFields, signer, artifactPolicy, { now })
  const terminal = journal.commit(key, requestDigest, { receipt: canonicalJson(receiptEvent),
    buzzEventId: event.id, result: accepted ? 'accepted' : 'refused', completedAt: now })
  return frozen({ status: 'terminal', result: terminal.result === 'refused' ? 'rejected' : terminal.result, receipt: terminal.receipt })
}

// Local policy-host operator path for the only unrecoverable interval: the signer
// returned but the exact event was not yet durably prepared. The forced-command
// request runner never calls this. Exact request bytes + claimed_at + the private
// recovery secret are all required, and the receipt states only "ambiguous".
export async function resolveBuzzPolicyOrphan(raw, expectedClaimedAt, {
  policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention = '',
  artifactPolicy, journal, signer, recoverySecret, now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!journal || typeof journal.get !== 'function' || typeof journal.resolveOrphan !== 'function') fail('recovery journal is unavailable')
  if (!signer || typeof signer.signEvent !== 'function') fail('signer is unavailable')
  if (!Number.isSafeInteger(expectedClaimedAt) || expectedClaimedAt < 0) fail('expectedClaimedAt is invalid')
  const { request, decision, requestDigest, key } = derive(raw, { policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention, now: expectedClaimedAt })
  const record = journal.get(key)
  if (!record || record.status !== 'in-flight' || record.claimed_at !== expectedClaimedAt) fail('the exact inspected in-flight claim is no longer present')
  const fields = {
    version: 1, policy_instance: policyInstance, operation: request.operation, catalogue_version: catalogueVersion,
    request_digest: requestDigest, idempotency_key: key, source_ids: [request.evidence.source_event.id],
    buzz_channel: decision.dest, endpoint_authority: artifactPolicy.endpointAuthority,
    buzz_event_id: null, result: 'ambiguous', reason_code: 'signing_outcome_unknown',
    response_digest: createHash('sha256').update('no-submission-evidence').digest('hex'), completed_at: now,
  }
  const receiptEvent = await buildSignedReceipt(fields, signer, artifactPolicy, { now })
  const terminal = journal.resolveOrphan(key, requestDigest, expectedClaimedAt, {
    recoverySecret, receipt: canonicalJson(receiptEvent), completedAt: now,
  })
  return frozen({ status: 'terminal', result: terminal.result, receipt: terminal.receipt })
}
