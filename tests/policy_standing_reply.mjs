import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { buildStandingTrustedReplyPolicyRequest, verifyPolicyResponse } from '../src/buzz_policy_client.mjs'
import { canonicalJson, decodePolicyRequest, decideStandingTrustedReply } from '../src/buzz_policy_core.mjs'
import { createArtifactPolicy } from '../src/buzz_policy_artifacts.mjs'
import { buildBuzzEvent, createProjectionPolicy } from '../src/buzz_policy_projection.mjs'
import { processBuzzPolicyRequest } from '../src/buzz_policy_service.mjs'
import { PolicyJournal } from '../src/policy_journal.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = (name, fn, pattern) => { try { fn(); ok(name, false) } catch (error) { ok(name, pattern.test(error.message)) } }
const now = 2_000_000_000, policyInstance = 'jaf-hive', catalogueVersion = 'c'.repeat(64)
const inbox = 'a8186b53-537d-46ad-a7e7-b6486c58970e', watched = 'd'.repeat(64)
const trustedSk = generateSecretKey(), trusted = getPublicKey(trustedSk)
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1,
  tags: [['e', watched]], content: 'meadow wisdom @everyone nostr:npub1trap' }, trustedSk)))
const raw = buildStandingTrustedReplyPolicyRequest(source, { policyInstance, catalogueVersion, observedAt: now })
const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now })
const decision = decideStandingTrustedReply(request, { inboxChannel: inbox, watchedEventIds: [watched], trustedRepliers: [trusted] })

ok('standing reply request is canonical evidence-only JSON', raw === canonicalJson(JSON.parse(raw)) &&
  Object.keys(JSON.parse(raw).evidence).join(',') === 'source_event')
ok('policy selects the inbox, source-only attribution, and permanently defused references',
  decision.dest === inbox && decision.template === 'released_post' && decision.slots.name === undefined &&
  decision.slots.liveRefs === false && decision.slots.npubShort.includes('…'))

const posterSk = generateSecretKey(), poster = getPublicKey(posterSk), ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:`)), ownerSk))
const authTag = ['auth', owner, '', authSig]
const projection = createProjectionPolicy({ posterPubkey: poster, authTag })
const unsigned = buildBuzzEvent(decision, projection, { now })
ok('standing reply projection defuses active references without altering signed source bytes in the request',
  unsigned.tags[0][1] === inbox && unsigned.content.includes('@​everyone') && unsigned.content.includes('nostr​:npub1trap') &&
  JSON.parse(raw).evidence.source_event.content === source.content)

const untrustedSource = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1,
  tags: [['e', watched]], content: 'not trusted' }, generateSecretKey())))
const untrustedRequest = decodePolicyRequest(buildStandingTrustedReplyPolicyRequest(untrustedSource,
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a bridge-supplied signed author cannot bypass policy-owned trusted_repliers',
  () => decideStandingTrustedReply(untrustedRequest, { inboxChannel: inbox, watchedEventIds: [watched], trustedRepliers: [trusted] }), /not a policy-trusted/)
refuses('a trusted author cannot use reply trust to start an unrelated thread',
  () => decideStandingTrustedReply(request, { inboxChannel: inbox, watchedEventIds: ['e'.repeat(64)], trustedRepliers: [trusted] }), /not a reply/)
refuses('the requester cannot choose the destination',
  () => decideStandingTrustedReply(request, { inboxChannel: 'waggle-test', watchedEventIds: [watched], trustedRepliers: [trusted] }), /channel UUID/)

const root = mkdtempSync(join(tmpdir(), 'waggle-standing-policy-'))
const endpoint = 'https://hive.example/events'
const artifactPolicy = createArtifactPolicy({ posterPubkey: poster, authTag, endpoint })
const journal = new PolicyJournal(join(root, 'journal'))
const signer = { pubkey: poster, signEvent: async event => finalizeEvent(event, posterSk) }
const response = await processBuzzPolicyRequest(raw, { policyInstance, catalogueVersion,
  stagingChannel: inbox, inboxChannel: inbox, watchedEventIds: [watched], trustedRepliers: [trusted],
  artifactPolicy, journal, signer, now, nonce: () => 'nonce_0123456789',
  fetchImpl: async (_url, init) => {
    const event = JSON.parse(init.body)
    const bytes = Buffer.from(JSON.stringify({ event_id: event.id, accepted: true, message: '' }))
    return { status: 200, headers: { get: () => String(bytes.length) }, body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  } })
const wire = canonicalJson(response)
const verified = verifyPolicyResponse(wire, { requestRaw: raw, posterPubkey: poster,
  expectedChannel: inbox, endpointAuthority: artifactPolicy.endpointAuthority })
ok('complete standing-reply transaction signs, submits, and verifies a receipt bound to this operation',
  verified.terminal && verified.result === 'accepted' && JSON.parse(response.receipt).content.includes('standing_trusted_reply'))
const expectedKey = createHash('sha256').update(canonicalJson([1, policyInstance, catalogueVersion,
  'standing_trusted_reply', [source.id], inbox])).digest('hex')
ok('standing reply idempotency is operation-, source-, and policy-destination-bound',
  JSON.parse(JSON.parse(response.receipt).content).idempotency_key === expectedKey)

rmSync(root, { recursive: true, force: true })
console.log(fails ? `\npolicy_standing_reply: ${fails} FAILED` : '\npolicy_standing_reply: all checks passed')
process.exit(fails ? 1 : 0)
