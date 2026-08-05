import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSecretKey, finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { canonicalJson } from '../src/buzz_policy_core.mjs'
import { createArtifactPolicy } from '../src/buzz_policy_artifacts.mjs'
import { PolicyJournal } from '../src/policy_journal.mjs'
import { processBuzzPolicyRequest } from '../src/buzz_policy_service.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = async (name, fn, pattern) => { try { await fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const now = 2_000_000_000, channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const catalogueVersion = 'c'.repeat(64), watchedId = 'd'.repeat(64), policyInstance = 'jaf-hive'
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1,
  tags: [['e', watchedId]], content: 'source wisdom' }, generateSecretKey())))
const raw = canonicalJson({ version: 1, policy_instance: policyInstance, operation: 'quarantine_header',
  catalogue_version: catalogueVersion, observed_at: now, evidence: { source_event: source } })
const posterSk = generateSecretKey(), ownerSk = generateSecretKey(), poster = getPublicKey(posterSk), owner = getPublicKey(ownerSk)
const conditions = '', authSig = bytesToHex(schnorr.sign(sha256(utf8ToBytes(`nostr:agent-auth:${poster}:${conditions}`)), ownerSk))
const artifactPolicy = createArtifactPolicy({ posterPubkey: poster, authTag: ['auth', owner, conditions, authSig], endpoint: 'https://hive.example/events' })
const response = (status, value) => { const bytes = Buffer.from(JSON.stringify(value)); return {
  status, headers: { get: () => String(bytes.length) }, body: null,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
} }
const acceptedResponse = event => response(200, { event_id: event.id, accepted: true, message: '' })
const dirs = []
const directory = () => { const value = mkdtempSync(join(tmpdir(), 'waggle-policy-service-')); dirs.push(value); return value }
const makeSigner = () => {
  const signed = []
  return { signed, signer: { async signEvent(event) { const wire = JSON.parse(JSON.stringify(finalizeEvent(event, posterSk))); signed.push(wire); return wire } } }
}
const options = (journal, signer, extra = {}) => ({ policyInstance, catalogueVersion, stagingChannel: channel,
  watchedEventIds: [watchedId], artifactPolicy, journal, signer, now, nonce: () => 'nonce_0123456789', ...extra })

{
  const journal = new PolicyJournal(directory()), { signer, signed } = makeSigner(); let calls = 0
  const first = await processBuzzPolicyRequest(raw, options(journal, signer, { fetchImpl: async (_url, request) => {
    calls++; return acceptedResponse(JSON.parse(request.body))
  } }))
  t('accepted work returns only a signed terminal receipt', first.status === 'terminal' && first.result === 'accepted' && JSON.parse(first.receipt).kind === 30078 && !('event' in first))
  t('the event, HTTP authorization, and receipt are each signed once', signed.map(x => x.kind).join(',') === '9,27235,30078')
  const replay = await processBuzzPolicyRequest(raw, options(journal, signer, { fetchImpl: async () => { calls++; throw new Error('must not submit') } }))
  t('a terminal replay returns byte-identical receipt without signing or network', replay.receipt === first.receipt && calls === 1 && signed.length === 3)
}

{
  const path = directory(), firstJournal = new PolicyJournal(path), firstSigner = makeSigner(); let preparedBody = ''
  const ambiguous = await processBuzzPolicyRequest(raw, options(firstJournal, firstSigner.signer, { fetchImpl: async (_url, request) => {
    preparedBody = request.body; throw new Error('socket lost after send')
  } }))
  t('an ambiguous submit leaves the exact event prepared', ambiguous.status === 'ambiguous' && firstJournal.get(createHash('sha256').update(canonicalJson([1, policyInstance, catalogueVersion, 'quarantine_header', [source.id], channel])).digest('hex')).status === 'prepared')
  const secondJournal = new PolicyJournal(path), secondSigner = makeSigner(); let recoveredBody = ''
  const recovered = await processBuzzPolicyRequest(raw, options(secondJournal, secondSigner.signer, { fetchImpl: async (_url, request) => {
    recoveredBody = request.body; return acceptedResponse(JSON.parse(request.body))
  } }))
  t('restart recovery resubmits byte-identical event and never re-signs kind:9', recovered.status === 'terminal' && recoveredBody === preparedBody && secondSigner.signed.map(x => x.kind).join(',') === '27235,30078')
}

{
  const journal = new PolicyJournal(directory()), { signer, signed } = makeSigner(); let calls = 0
  const held = await processBuzzPolicyRequest(raw, options(journal, signer, { fetchImpl: async () => { calls++; return response(429, { error: 'rate limit' }) } }))
  const retry = await processBuzzPolicyRequest(raw, options(new PolicyJournal(journal.directory), signer, { fetchImpl: async (_url, request) => { calls++; return acceptedResponse(JSON.parse(request.body)) } }))
  t('429 retries the same prepared event with fresh authorization', held.status === 'held' && retry.result === 'accepted' && calls === 2 && signed.filter(x => x.kind === 9).length === 1 && signed.filter(x => x.kind === 27235).length === 2)
}

{
  const journal = new PolicyJournal(directory()), { signer } = makeSigner()
  const refused = await processBuzzPolicyRequest(raw, options(journal, signer, { fetchImpl: async (_url, request) => response(200,
    { event_id: JSON.parse(request.body).id, accepted: false, message: 'moderated' }) }))
  const fields = JSON.parse(JSON.parse(refused.receipt).content)
  t('authoritative exact-event refusal is terminal and binds the attempted event without claiming acceptance', refused.result === 'rejected' && fields.reason_code === 'relay_refused' && /^[0-9a-f]{64}$/.test(fields.buzz_event_id))
}

{
  const journal = new PolicyJournal(directory()), { signer } = makeSigner()
  const refused = await processBuzzPolicyRequest(raw, options(journal, signer, { fetchImpl: async () => response(403, { error: 'forbidden' }) }))
  t('a generic 4xx is ambiguous because it does not bind an exact-event outcome', refused.status === 'ambiguous' && refused.receipt === null && journal.get(createHash('sha256').update(canonicalJson([1, policyInstance, catalogueVersion, 'quarantine_header', [source.id], channel])).digest('hex')).status === 'prepared')
}

{
  const journal = new PolicyJournal(directory()), badSigner = { signEvent: event => finalizeEvent(event, generateSecretKey()) }
  await rejects('a substituted signing identity cannot create a durable prepared event', () => processBuzzPolicyRequest(raw, options(journal, badSigner, { fetchImpl: async () => response(500, {}) })), /changed policy-owned/)
}

for (const path of dirs) rmSync(path, { recursive: true, force: true })
console.log(fails ? `\nbuzz_policy_service: ${fails} FAILED` : '\nbuzz_policy_service: all checks passed')
process.exit(fails ? 1 : 0)
