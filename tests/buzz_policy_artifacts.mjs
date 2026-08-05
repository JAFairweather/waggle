import { createHash } from 'node:crypto'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { decodePolicyRequest, decideQuarantineHeader, canonicalJson, policyIdempotencyKey } from '../src/buzz_policy_core.mjs'
import { buildBuzzEvent, signExactBuzzEvent, buildNip98Authorization, signExactNip98, buildSignedReceipt } from '../src/buzz_policy_artifacts.mjs'

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
const unsigned = buildBuzzEvent(decision, { posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], now })
t('the policy constructs kind:9 content and destination from its decision', unsigned.kind === 9 && unsigned.tags[0][1] === decision.dest && unsigned.content.includes('hostile'))
t('hostile source prose is rendered as attributed carried content', !/^# hostile/m.test(unsigned.content) && !/^@everyone/m.test(unsigned.content))
await rejects('an owner attestation for another poster is refused', () => buildBuzzEvent(decision, { posterPubkey: getPublicKey(bad), authTag: ['auth', owner, conditions, authSig], now }), /owner signature/)
const signed = await signExactBuzzEvent(unsigned, sign)
t('the exact policy-owned Buzz event is signed and verified', signed.kind === 9 && signed.content === unsigned.content)
await rejects('a signer cannot substitute its own event bytes', () => signExactBuzzEvent(unsigned, { signEvent: event => finalizeEvent({ ...event, content: 'changed' }, bad) }), /changed policy-owned/)
const nip98 = buildNip98Authorization(signed, { endpoint: 'https://nave.example/events', nonce: 'nonce_0123456789', now })
t('NIP-98 pins POST, endpoint, and canonical body hash', nip98.event.tags.some(x => x[0] === 'payload' && x[1] === createHash('sha256').update(nip98.body).digest('hex')))
const signedAuth = await signExactNip98(nip98.event, sign)
t('the exact policy-owned NIP-98 event is signed and verified', signedAuth.kind === 27235)
await rejects('a signer cannot redirect NIP-98 authorization', () => signExactNip98(nip98.event, { signEvent: event => finalizeEvent({ ...event, tags: [['u', 'https://evil.example/events']] }, bad) }), /changed policy-owned/)
await rejects('a caller cannot authorize an unsafe endpoint', () => buildNip98Authorization(signed, { endpoint: 'http://nave.example/events?to=evil', nonce: 'nonce_0123456789', now }), /fixed HTTPS/)
const key = policyIdempotencyKey(request, decision)
const receiptFields = { version: 1, policy_instance: packet.policy_instance, operation: packet.operation, catalogue_version: packet.catalogue_version,
  request_digest: createHash('sha256').update(raw).digest('hex'), idempotency_key: key, source_ids: [source.id], buzz_channel: decision.dest,
  endpoint_authority: 'nave.example', buzz_event_id: signed.id, result: 'accepted', reason_code: 'accepted', response_digest: 'e'.repeat(64), completed_at: now }
const receipt = await buildSignedReceipt(receiptFields, sign, { posterPubkey: poster, now })
t('the return is a signed canonical receipt, not the signed Buzz event', receipt.kind === 30078 && receipt.content === canonicalJson(receiptFields) && !receipt.content.includes(signed.sig))
await rejects('a signer cannot substitute the receipt identity', () => buildSignedReceipt(receiptFields, { signEvent: event => finalizeEvent(event, bad) }, { posterPubkey: poster, now }), /changed policy-owned/)
await rejects('receipt fields cannot be widened', () => buildSignedReceipt({ ...receiptFields, authorization: 'reusable' }, sign, { posterPubkey: poster, now }), /invalid shape/)

console.log(fails ? `\nbuzz_policy_artifacts: ${fails} FAILED` : '\nbuzz_policy_artifacts: all checks passed')
process.exit(fails ? 1 : 0)
