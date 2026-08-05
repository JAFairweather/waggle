import { createHash } from 'node:crypto'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { decodePolicyRequest, decideQuarantineHeader, canonicalJson, policyIdempotencyKey } from '../src/buzz_policy_core.mjs'
import { createArtifactPolicy, buildBuzzEvent, signExactBuzzEvent, buildNip98Authorization, signExactNip98, submitBuzzEvent, buildSignedReceipt } from '../src/buzz_policy_artifacts.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = async (name, fn, pattern) => { try { await fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const now = 2_000_000_000, sk = generateSecretKey(), bad = generateSecretKey()
const sign = { signEvent: event => finalizeEvent(event, sk) }
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1, tags: [['e', 'd'.repeat(64)]], content: '# hostile\n@everyone' }, generateSecretKey())))
const packet = { version: 1, policy_instance: 'jaf-hive', operation: 'quarantine_header', catalogue_version: 'c'.repeat(64), observed_at: now, evidence: { source_event: source } }
const raw = canonicalJson(packet), request = decodePolicyRequest(raw, { policyInstance: 'jaf-hive', catalogueVersion: 'c'.repeat(64), now })
const decision = decideQuarantineHeader(request, { stagingChannel: 'a8186b53-537d-46ad-a7e7-b6486c58970e', watchedEventIds: ['d'.repeat(64)] })
const ownerSk = generateSecretKey(), poster = getPublicKey(sk), owner = getPublicKey(ownerSk), conditions = ''
const authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${conditions}`)), ownerSk))
const policy = createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], endpoint: 'https://nave.example/events' })
const unsigned = buildBuzzEvent(decision, policy, { now })
t('the policy constructs kind:9 content and destination from its decision', unsigned.kind === 9 && unsigned.tags[0][1] === decision.dest && unsigned.content.includes('hostile'))
t('hostile source prose is rendered as attributed carried content', !/^# hostile/m.test(unsigned.content) && !/^@everyone/m.test(unsigned.content))
await rejects('an owner attestation for another poster is refused', () => createArtifactPolicy({ posterPubkey: getPublicKey(bad), authTag: ['auth', owner, conditions, authSig], endpoint: 'https://nave.example/events' }), /owner signature/)
await rejects('a host-fabricated decision is refused', () => buildBuzzEvent({ ...decision }, policy, { now }), /internally derived policy decision/)
await rejects('a host-fabricated artifact policy is refused', () => buildBuzzEvent(decision, { ...policy }, { now }), /internally configured artifact policy/)
const signed = await signExactBuzzEvent(unsigned, sign)
t('the exact policy-owned Buzz event is signed and verified', signed.kind === 9 && signed.content === unsigned.content)
await rejects('a signer cannot substitute its own event bytes', () => signExactBuzzEvent(unsigned, { signEvent: event => finalizeEvent({ ...event, content: 'changed' }, bad) }), /changed policy-owned/)
const nip98 = buildNip98Authorization(signed, policy, { nonce: 'nonce_0123456789', now })
t('NIP-98 pins POST, endpoint, and canonical body hash', nip98.event.tags.some(x => x[0] === 'payload' && x[1] === createHash('sha256').update(nip98.body).digest('hex')))
const signedAuth = await signExactNip98(nip98.event, sign)
t('the exact policy-owned NIP-98 event is signed and verified', signedAuth.kind === 27235)
await rejects('a signer cannot redirect NIP-98 authorization', () => signExactNip98(nip98.event, { signEvent: event => finalizeEvent({ ...event, tags: [['u', 'https://evil.example/events']] }, bad) }), /changed policy-owned/)
await rejects('a caller cannot configure an unsafe endpoint', () => createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], endpoint: 'http://nave.example/events?to=evil' }), /fixed HTTPS/)
const evilPolicy = createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], endpoint: 'https://evil.example/events' })
await rejects('a caller cannot swap a different policy object into NIP-98 construction', () => buildNip98Authorization(signed, { ...evilPolicy }, { nonce: 'nonce_0123456789', now }), /internally configured artifact policy/)
const key = policyIdempotencyKey(request, decision)
await rejects('a host-fabricated request cannot choose idempotency', () => policyIdempotencyKey({ ...request }, decision), /not bound to this verified request/)
let submitted
const acceptedOutcome = await submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async (url, init) => {
  submitted = { url, init }
  return new globalThis.Response(JSON.stringify({ event_id: signed.id, accepted: true, message: '' }), { status: 200 })
} })
t('the policy service submits exact bytes and keeps authorization inside the call', submitted.url === policy.endpoint && submitted.init.body === canonicalJson(signed) && submitted.init.headers.authorization.startsWith('Nostr ') && submitted.init.headers['x-auth-tag'] === JSON.stringify(policy.authTag) && acceptedOutcome.result === 'accepted')
await rejects('NIP-98 for another payload cannot be submitted', () => submitBuzzEvent({ ...signed, content: 'changed' }, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response() }), /signature or id|exact submission/)
await rejects('a stale but valid NIP-98 event is refused before network I/O', () => submitBuzzEvent(signed, signedAuth, policy, { now: now + 61, fetchImpl: async () => new globalThis.Response() }), /freshness window/)
await rejects('a redirect is never followed as authority', () => submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response('', { status: 302 }) }), /retryable/)
await rejects('a transient relay response stays retryable', () => submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response('', { status: 503 }) }), /retryable/)
await rejects('a proxy or WAF 403 cannot mint a terminal refusal', () => submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response('{"error":"denied"}', { status: 403, headers: { 'content-type': 'application/json' } }) }), /not an authoritative exact-event outcome/)
const boundedPolicy = createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], endpoint: 'https://nave.example/events', maxResponseBytes: 1024 })
await rejects('an oversized response is refused before interpretation', () => submitBuzzEvent(signed, signedAuth, boundedPolicy, { now, fetchImpl: async () => new globalThis.Response('x'.repeat(1025)) }), /exceeds the policy limit/)
await rejects('a success response for another event is refused', () => submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response(JSON.stringify({ event_id: 'f'.repeat(64), accepted: true, message: '' }), { status: 200 }) }), /event binding/)
const refusedOutcome = await submitBuzzEvent(signed, signedAuth, policy, { now, fetchImpl: async () => new globalThis.Response(JSON.stringify({ event_id: signed.id, accepted: false, message: 'policy refusal' }), { status: 200 }) })
t('an authoritative accepted:false is a terminal refusal', refusedOutcome.result === 'rejected' && refusedOutcome.reasonCode === 'relay_refused')
const foreignOwnerSk = generateSecretKey(), foreignOwner = getPublicKey(foreignOwnerSk)
const foreignSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${conditions}`)), foreignOwnerSk))
const foreignPolicy = createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', foreignOwner, conditions, foreignSig], endpoint: 'https://nave.example/events' })
let foreignFetches = 0
await rejects('a valid foreign owner policy cannot submit this event', () => submitBuzzEvent(signed, signedAuth, foreignPolicy, { now, fetchImpl: async () => { foreignFetches++; return new globalThis.Response() } }), /configured owner attestation/)
t('owner-policy mismatch is refused before network I/O', foreignFetches === 0)
const receiptFields = { version: 1, policy_instance: packet.policy_instance, operation: packet.operation, catalogue_version: packet.catalogue_version,
  request_digest: createHash('sha256').update(raw).digest('hex'), idempotency_key: key, source_ids: [source.id], buzz_channel: decision.dest,
  endpoint_authority: 'nave.example', buzz_event_id: signed.id, result: 'accepted', reason_code: 'accepted', response_digest: 'e'.repeat(64), completed_at: now }
const receipt = await buildSignedReceipt(receiptFields, sign, policy, { now })
t('the return is a signed canonical receipt, not the signed Buzz event', receipt.kind === 30078 && receipt.content === canonicalJson(receiptFields) && !receipt.content.includes(signed.sig))
await rejects('a signer cannot substitute the receipt identity', () => buildSignedReceipt(receiptFields, { signEvent: event => finalizeEvent(event, bad) }, policy, { now }), /changed policy-owned/)
await rejects('receipt fields cannot be widened', () => buildSignedReceipt({ ...receiptFields, authorization: 'reusable' }, sign, policy, { now }), /invalid shape/)
await rejects('a receipt cannot name a caller-selected endpoint', () => buildSignedReceipt({ ...receiptFields, endpoint_authority: 'evil.example' }, sign, policy, { now }), /endpoint_authority is not policy-owned/)
const rejectedFields = { ...receiptFields, result: refusedOutcome.result, reason_code: refusedOutcome.reasonCode, response_digest: refusedOutcome.responseDigest }
const rejectedReceipt = await buildSignedReceipt(rejectedFields, sign, policy, { now })
t('an authoritative refusal becomes a signed terminal receipt', JSON.parse(rejectedReceipt.content).reason_code === 'relay_refused')

console.log(fails ? `\nbuzz_policy_artifacts: ${fails} FAILED` : '\nbuzz_policy_artifacts: all checks passed')
process.exit(fails ? 1 : 0)
