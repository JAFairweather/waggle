import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { sha256 } from '@noble/hashes/sha256'
import { schnorr } from '@noble/curves/secp256k1'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildWithdrawRepostPolicyRequest, policyRequestQueueKey, verifyPolicyResponse } from '../src/buzz_policy_client.mjs'
import { canonicalJson, decodePolicyRequest, decideWithdrawRepost, policyIdempotencyKey } from '../src/buzz_policy_core.mjs'
import { createArtifactPolicy } from '../src/buzz_policy_artifacts.mjs'
import { buildBuzzEvent, createProjectionPolicy } from '../src/buzz_policy_projection.mjs'
import { processBuzzPolicyRequest } from '../src/buzz_policy_service.mjs'
import { PolicyJournal } from '../src/policy_journal.mjs'
import { deriveBuzzPolicyShadow } from '../src/buzz_policy_shadow.mjs'
import { comparePolicyShadow } from '../src/buzz_policy_shadow_client.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = (name, fn, pattern) => { try { fn(); ok(name, false) } catch (error) { ok(name, pattern.test(error.message)) } }
const wire = value => JSON.parse(JSON.stringify(value))
const now = 2_000_000_000, policyInstance = 'jaf-hive', catalogueVersion = 'c'.repeat(64)
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e', endpointAuthority = 'hive.example'
const authorSk = generateSecretKey(), source = wire(finalizeEvent({ kind: 1, created_at: now - 3,
  tags: [], content: 'wisdom later withdrawn' }, authorSk))
const second = wire(finalizeEvent({ kind: 1, created_at: now - 2, tags: [], content: 'another target' }, authorSk))
const deletion = wire(finalizeEvent({ kind: 5, created_at: now - 1,
  tags: [['e', source.id], ['e', second.id]], content: 'withdrawn by author' }, authorSk))
const posterSk = generateSecretKey(), poster = getPublicKey(posterSk), buzzEventId = 'b'.repeat(64)

const acceptedReceipt = (mappedSource = source, mappedBuzz = buzzEventId, overrides = {}) => {
  const operation = 'quarantine_header'
  const key = createHash('sha256').update(canonicalJson([1, policyInstance, catalogueVersion,
    operation, [mappedSource.id], channel])).digest('hex')
  const fields = { version: 1, policy_instance: policyInstance, operation, catalogue_version: catalogueVersion,
    request_digest: 'd'.repeat(64), idempotency_key: key, source_ids: [mappedSource.id], buzz_channel: channel,
    endpoint_authority: endpointAuthority, buzz_event_id: mappedBuzz, result: 'accepted', reason_code: 'accepted',
    response_digest: 'e'.repeat(64), completed_at: now - 2, ...overrides }
  return wire(finalizeEvent({ kind: 30078, created_at: fields.completed_at,
    tags: [['d', `waggle-policy:${fields.idempotency_key}`]], content: canonicalJson(fields) }, posterSk))
}

const prior = acceptedReceipt()
const raw = buildWithdrawRepostPolicyRequest(source, deletion, prior,
  { policyInstance, catalogueVersion, observedAt: now })
const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now })
const decision = decideWithdrawRepost(request,
  { posterPubkey: poster, endpointAuthority, policyInstance, catalogueVersion })
const expectedQueueKey = createHash('sha256').update(canonicalJson([deletion.id, source.id])).digest('hex')
ok('withdrawal request carries only complete signed source, deletion, and prior policy receipt',
  raw === canonicalJson(JSON.parse(raw)) && Object.keys(JSON.parse(raw).evidence).join(',') === 'deletion_event,prior_receipt,source_event')
ok('one multi-target NIP-09 event yields a stable per-source durable queue key',
  policyRequestQueueKey(raw) === expectedQueueKey)
ok('policy host derives destination and Buzz target solely from its own prior receipt',
  decision.template === 'withdraw_repost' && decision.dest === channel && decision.targetId === buzzEventId)

const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:`)), ownerSk))
const authTag = ['auth', owner, '', authSig]
const projection = createProjectionPolicy({ posterPubkey: poster, authTag })
const unsigned = buildBuzzEvent(decision, projection, { now })
ok('projection is one exact same-author Buzz kind:5, not an admin deletion or caller-selected mutation',
  unsigned.kind === 5 && unsigned.content === '' && canonicalJson(unsigned.tags) === canonicalJson([
    ['h', channel], ['e', buzzEventId], authTag,
  ]))
const shadow = deriveBuzzPolicyShadow(raw, { policyInstance, catalogueVersion, posterPubkey: poster,
  endpointAuthority, projectionPolicy: projection, now })
const comparison = comparePolicyShadow(raw, `${canonicalJson(shadow)}\n`, { policyInstance,
  catalogueVersion, posterPubkey: poster, endpointAuthority, authTag })
ok('derive-only shadow and bridge comparator agree on the exact receipt-derived deletion',
  shadow.decision === 'allow' && comparison.match && comparison.localDigest === shadow.unsigned_event_sha256)

const wrongAuthorDelete = wire(finalizeEvent({ kind: 5, created_at: now - 1,
  tags: [['e', source.id]], content: '' }, generateSecretKey()))
const wrongAuthorRequest = decodePolicyRequest(buildWithdrawRepostPolicyRequest(source, wrongAuthorDelete, prior,
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a different author cannot withdraw the source', () => decideWithdrawRepost(wrongAuthorRequest,
  { posterPubkey: poster, endpointAuthority, policyInstance, catalogueVersion }), /does not own/)

const unrelatedDelete = wire(finalizeEvent({ kind: 5, created_at: now - 1,
  tags: [['e', second.id]], content: '' }, authorSk))
const unrelatedRequest = decodePolicyRequest(buildWithdrawRepostPolicyRequest(source, unrelatedDelete, prior,
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a signed deletion must explicitly name this source', () => decideWithdrawRepost(unrelatedRequest,
  { posterPubkey: poster, endpointAuthority, policyInstance, catalogueVersion }), /does not target/)

const forgedPrior = wire(prior); forgedPrior.sig = `${forgedPrior.sig[0] === '0' ? '1' : '0'}${forgedPrior.sig.slice(1)}`
refuses('a forged prior receipt cannot choose a Buzz target', () => decodePolicyRequest(
  buildWithdrawRepostPolicyRequest(source, deletion, forgedPrior, { policyInstance, catalogueVersion, observedAt: now }),
  { policyInstance, catalogueVersion, now }), /signature or id/)
const wrongMapping = acceptedReceipt(second)
const wrongMappingRequest = decodePolicyRequest(buildWithdrawRepostPolicyRequest(source, deletion, wrongMapping,
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a valid receipt for another source cannot be rebound', () => decideWithdrawRepost(wrongMappingRequest,
  { posterPubkey: poster, endpointAuthority, policyInstance, catalogueVersion }), /source mapping/)
const wrongEndpoint = decodePolicyRequest(buildWithdrawRepostPolicyRequest(source, deletion,
  acceptedReceipt(source, buzzEventId, { endpoint_authority: 'attacker.example' }),
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a receipt from another endpoint authority cannot migrate a target', () => decideWithdrawRepost(wrongEndpoint,
  { posterPubkey: poster, endpointAuthority, policyInstance, catalogueVersion }), /source mapping/)

const artifactPolicy = createArtifactPolicy({ posterPubkey: poster, authTag, endpoint: 'https://hive.example/events' })
const root = mkdtempSync(join(tmpdir(), 'waggle-withdraw-policy-'))
const journal = new PolicyJournal(join(root, 'journal'))
let submitted
const response = await processBuzzPolicyRequest(raw, { policyInstance, catalogueVersion,
  artifactPolicy, journal, signer: { pubkey: poster, signEvent: async event => finalizeEvent(event, posterSk) },
  now, nonce: () => 'nonce_0123456789', fetchImpl: async (_url, init) => {
    submitted = JSON.parse(init.body)
    const bytes = Buffer.from(JSON.stringify({ event_id: submitted.id, accepted: true, message: '' }))
    return { status: 200, headers: { get: () => String(bytes.length) }, body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  } })
const verified = verifyPolicyResponse(canonicalJson(response), { requestRaw: raw, posterPubkey: poster,
  expectedChannel: channel, endpointAuthority })
ok('complete withdrawal signs, submits, journals, and returns a verifiable receipt',
  submitted.kind === 5 && submitted.tags[1][1] === buzzEventId && verified.terminal && verified.result === 'accepted')
ok('withdrawal idempotency binds all three signed evidence records and the receipt-derived destination',
  JSON.parse(verified.receipt.content).idempotency_key === policyIdempotencyKey(request, decision))

rmSync(root, { recursive: true, force: true })
console.log(fails ? `\npolicy_withdraw_repost: ${fails} FAILED` : '\npolicy_withdraw_repost: all checks passed')
process.exit(fails ? 1 : 0)
