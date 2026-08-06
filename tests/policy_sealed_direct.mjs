import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { buildSealedDirectPolicyRequest, normalizePolicyOperations, verifyPolicyResponse } from '../src/buzz_policy_client.mjs'
import { canonicalJson, decodePolicyRequest, decideSealedDirectEnvelope } from '../src/buzz_policy_core.mjs'
import { createArtifactPolicy } from '../src/buzz_policy_artifacts.mjs'
import { buildBuzzEvent, createProjectionPolicy } from '../src/buzz_policy_projection.mjs'
import { processBuzzPolicyRequest } from '../src/buzz_policy_service.mjs'
import { PolicyJournal } from '../src/policy_journal.mjs'
import { renderSealedDirect } from '../src/render.mjs'
import { deriveBuzzPolicyShadow } from '../src/buzz_policy_shadow.mjs'
import { comparePolicyShadow } from '../src/buzz_policy_shadow_client.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const refuses = (name, fn, pattern) => { try { fn(); ok(name, false) } catch (error) { ok(name, pattern.test(error.message)) } }
const now = 2_000_000_000, policyInstance = 'jaf-hive', catalogueVersion = 'c'.repeat(64)
const inbox = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const recipient = getPublicKey(generateSecretKey()), wrapSk = generateSecretKey()
const wrap = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1059, created_at: now - 1,
  tags: [['p', recipient]], content: 'opaque-nip44-ciphertext' }, wrapSk)))
const routes = { [recipient]: { inbox, name: 'Codex - 231952cb' } }
const raw = buildSealedDirectPolicyRequest(wrap, { policyInstance, catalogueVersion, observedAt: now })
const request = decodePolicyRequest(raw, { policyInstance, catalogueVersion, now })
const decision = decideSealedDirectEnvelope(request, { recipientRoutes: routes })

ok('legacy bridge configs cannot silently move a newly shipped operation remote-only',
  canonicalJson(normalizePolicyOperations()) === canonicalJson(['quarantine_header', 'standing_trusted_reply']) &&
  !normalizePolicyOperations().includes('sealed_direct_envelope'))
refuses('operation migration rejects duplicates and unknown family names',
  () => normalizePolicyOperations(['sealed_direct_envelope', 'sealed_direct_envelope']), /unique non-empty closed/)

ok('sealed-direct request is canonical and carries only the complete signed outer wrap',
  raw === canonicalJson(JSON.parse(raw)) && Object.keys(JSON.parse(raw).evidence).join(',') === 'source_event')
ok('policy resolves the signed recipient through its own fixed roster', decision.dest === inbox &&
  decision.template === 'sealed_envelope' && decision.slots.name === routes[recipient].name &&
  decision.slots.wrapJson === canonicalJson(wrap) && decision.slots.channel === undefined)

const posterSk = generateSecretKey(), poster = getPublicKey(posterSk), ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk)
const authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:`)), ownerSk))
const authTag = ['auth', owner, '', authSig]
const projection = createProjectionPolicy({ posterPubkey: poster, authTag })
const unsigned = buildBuzzEvent(decision, projection, { now })
ok('off-box projection is byte-identical to the shared direct-envelope renderer',
  unsigned.content === renderSealedDirect(decision.slots) && unsigned.tags[0][1] === inbox)
const shadow = deriveBuzzPolicyShadow(raw, { policyInstance, catalogueVersion, stagingChannel: inbox,
  inboxChannel: inbox, watchedEventIds: [], recipientRoutes: routes, projectionPolicy: projection, now })
const compared = comparePolicyShadow(raw, `${canonicalJson(shadow)}\n`, { policyInstance, catalogueVersion,
  stagingChannel: inbox, inboxChannel: inbox, watchedEventIds: [], recipientRoutes: routes,
  posterPubkey: poster, authTag })
ok('derive-only shadow and bridge-side projection agree on the exact sealed-DM bytes',
  shadow.decision === 'allow' && compared.match && compared.localDigest === shadow.unsigned_event_sha256)

const twoRecipients = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1059, created_at: now - 1,
  tags: [['p', recipient], ['p', getPublicKey(generateSecretKey())]], content: 'ciphertext' }, generateSecretKey())))
const twoRequest = decodePolicyRequest(buildSealedDirectPolicyRequest(twoRecipients,
  { policyInstance, catalogueVersion, observedAt: now }), { policyInstance, catalogueVersion, now })
refuses('a multi-recipient or channel-decoy wrap cannot enter the direct-DM operation',
  () => decideSealedDirectEnvelope(twoRequest, { recipientRoutes: routes }), /exactly one recipient/)
refuses('an unknown recipient cannot choose a destination through the bridge',
  () => decideSealedDirectEnvelope(request, { recipientRoutes: {} }), /not in the policy roster/)
refuses('policy roster names cannot inject a second mention or markup',
  () => decideSealedDirectEnvelope(request, { recipientRoutes: { [recipient]: { inbox, name: '@Owner' } } }), /recipient name/)
refuses('a kind:1 note cannot masquerade as a sealed direct envelope',
  () => buildSealedDirectPolicyRequest(JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now,
    tags: [['p', recipient]], content: 'plaintext' }, generateSecretKey()))), { policyInstance, catalogueVersion, observedAt: now }), /kind:1059/)

const root = mkdtempSync(join(tmpdir(), 'waggle-sealed-direct-policy-'))
const artifactPolicy = createArtifactPolicy({ posterPubkey: poster, authTag, endpoint: 'https://hive.example/events' })
const journal = new PolicyJournal(join(root, 'journal'))
let submissions = 0
const response = await processBuzzPolicyRequest(raw, { policyInstance, catalogueVersion,
  stagingChannel: inbox, inboxChannel: inbox, watchedEventIds: [], recipientRoutes: routes,
  artifactPolicy, journal, signer: { pubkey: poster, signEvent: async event => finalizeEvent(event, posterSk) },
  now, nonce: () => 'nonce_0123456789', fetchImpl: async (_url, init) => {
    submissions++
    const event = JSON.parse(init.body)
    const bytes = Buffer.from(JSON.stringify({ event_id: event.id, accepted: true, message: '' }))
    return { status: 200, headers: { get: () => String(bytes.length) }, body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  } })
const verified = verifyPolicyResponse(canonicalJson(response), { requestRaw: raw, posterPubkey: poster,
  expectedChannel: inbox, endpointAuthority: artifactPolicy.endpointAuthority })
ok('complete sealed-direct transaction signs, submits, and verifies one source-bound receipt',
  submissions === 1 && verified.terminal && verified.result === 'accepted')
const expectedKey = createHash('sha256').update(canonicalJson([1, policyInstance, catalogueVersion,
  'sealed_direct_envelope', [wrap.id], inbox])).digest('hex')
ok('sealed-direct idempotency binds operation, signed wrap, and policy-resolved inbox',
  JSON.parse(JSON.parse(response.receipt).content).idempotency_key === expectedKey)

rmSync(root, { recursive: true, force: true })
console.log(fails ? `\npolicy_sealed_direct: ${fails} FAILED` : '\npolicy_sealed_direct: all checks passed')
process.exit(fails ? 1 : 0)
