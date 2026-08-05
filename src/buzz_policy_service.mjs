// End-to-end off-box Buzz policy transaction.  The untrusted bridge contributes
// only canonical signed evidence.  This service independently decides, signs,
// durably prepares, submits, and returns only a signed receipt.
import { createHash, randomBytes } from 'node:crypto'
import { canonicalJson, decodePolicyRequest, decideQuarantineHeader, policyIdempotencyKey } from './buzz_policy_core.mjs'
import { buildBuzzEvent, buildNip98Authorization, buildSignedReceipt, signExactBuzzEvent, signExactNip98, verifySignedBuzzEvent } from './buzz_policy_artifacts.mjs'
import { submitSignedBuzzEvent } from './buzz_policy_submit.mjs'

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
  if (record.status === 'terminal') return frozen({ status: 'terminal', result: record.result, receipt: record.receipt })
  return frozen({ status: record.status === 'prepared' ? 'recoverable' : 'held', result: null, receipt: null })
}

export async function processBuzzPolicyRequest(raw, {
  policyInstance, catalogueVersion, stagingChannel, watchedEventIds, approverMention = '',
  artifactPolicy, journal, signer, fetchImpl = fetch, now = Math.floor(Date.now() / 1000),
  nonce = () => randomBytes(24).toString('base64url'), timeoutMs = 20_000,
} = {}) {
  if (!journal || typeof journal.claim !== 'function' || typeof journal.prepare !== 'function' || typeof journal.commit !== 'function') fail('journal is unavailable')
  if (!signer || typeof signer.signEvent !== 'function') fail('signer is unavailable')
  const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now })
  const decision = decideQuarantineHeader(request, { stagingChannel, watchedEventIds, approverMention })
  const requestDigest = createHash('sha256').update(raw).digest('hex')
  const key = policyIdempotencyKey(request, decision)
  const claim = journal.claim(key, requestDigest, now)
  if (!claim.claimed && claim.record.status !== 'prepared') return replay(claim.record)

  let event
  if (claim.record.status === 'prepared') event = preparedEvent(claim.record, decision, artifactPolicy)
  else {
    const unsigned = buildBuzzEvent(decision, artifactPolicy, { now })
    event = await signExactBuzzEvent(unsigned, signer)
    const eventText = canonicalJson(event)
    const durable = journal.prepare(key, requestDigest, { buzzEvent: eventText, buzzEventId: event.id, preparedAt: now })
    event = preparedEvent(durable, decision, artifactPolicy)
  }

  const authorization = buildNip98Authorization(event, artifactPolicy, { nonce: nonce(), now })
  const signedAuthorization = await signExactNip98(authorization.event, signer)
  const outcome = await submitSignedBuzzEvent({ endpoint: artifactPolicy.endpoint, event, authorization: signedAuthorization, fetchImpl, timeoutMs })
  if (outcome.status === 'held' || outcome.status === 'ambiguous') {
    return frozen({ status: outcome.status, result: null, receipt: null })
  }

  const accepted = outcome.status === 'accepted'
  const receiptFields = {
    version: 1, policy_instance: policyInstance, operation: request.operation, catalogue_version: catalogueVersion,
    request_digest: requestDigest, idempotency_key: key, source_ids: [request.evidence.source_event.id],
    buzz_channel: decision.dest, endpoint_authority: artifactPolicy.endpointAuthority,
    buzz_event_id: accepted ? event.id : null, result: accepted ? 'accepted' : 'refused',
    reason_code: accepted ? 'accepted' : 'buzz-refused', response_digest: outcome.response_digest, completed_at: now,
  }
  const receiptEvent = await buildSignedReceipt(receiptFields, signer, artifactPolicy, { now })
  const terminal = journal.commit(key, requestDigest, { receipt: canonicalJson(receiptEvent),
    buzzEventId: accepted ? event.id : null, result: receiptFields.result, completedAt: now })
  return frozen({ status: 'terminal', result: terminal.result, receipt: terminal.receipt })
}
