import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure'
import { BUZZ_POLICY_VERSION, canonicalJson, decodePolicyRequest, decideQuarantineHeader, policyIdempotencyKey, quarantineSlotsFromSource } from '../src/buzz_policy_core.mjs'

let fails = 0
const t = (name, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} — ${name}`); if (!ok) fails++ }
const rejects = (name, fn, pattern) => { try { fn(); t(name, false) } catch (e) { t(name, pattern.test(e.message)) } }
const now = 2_000_000_000
const catalogue = 'c'.repeat(64)
const watched = 'd'.repeat(64)
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const source = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: now - 1, tags: [['e', watched]], content: 'hostile @mention\n# heading' }, generateSecretKey())))
const packet = { version: BUZZ_POLICY_VERSION, policy_instance: 'jaf-hive', operation: 'quarantine_header', catalogue_version: catalogue, observed_at: now, evidence: { source_event: source } }
const raw = canonicalJson(packet)
const opts = { policyInstance: 'jaf-hive', catalogueVersion: catalogue, now }

const decoded = decodePolicyRequest(raw, opts)
t('an exact canonical packet with a real signed source is accepted', decoded.evidence.source_event.id === source.id)
rejects('pretty/whitespace-varied JSON is refused at the digest boundary', () => decodePolicyRequest(JSON.stringify(packet, null, 2), opts), /not canonical/)
rejects('duplicate JSON keys are refused at the digest boundary', () => decodePolicyRequest(raw.replace('"version":1', '"version":1,"version":1'), opts), /not canonical/)
rejects('caller-supplied approved decision is structurally impossible', () => decodePolicyRequest(canonicalJson({ ...packet, approved: true }), opts), /unknown field/)
rejects('caller-supplied rendered body is structurally impossible', () => decodePolicyRequest(canonicalJson({ ...packet, evidence: { ...packet.evidence, body: 'say this' } }), opts), /unknown field/)
rejects('caller-supplied destination is structurally impossible', () => decodePolicyRequest(canonicalJson({ ...packet, evidence: { ...packet.evidence, destination: channel } }), opts), /unknown field/)
rejects('another policy instance cannot replay the packet', () => decodePolicyRequest(raw, { ...opts, policyInstance: 'other-hive' }), /policy_instance/)
rejects('another catalogue cannot reinterpret the packet', () => decodePolicyRequest(raw, { ...opts, catalogueVersion: 'e'.repeat(64) }), /catalogue_version/)
rejects('stale observation is refused', () => decodePolicyRequest(canonicalJson({ ...packet, observed_at: now - 301 }), opts), /freshness/)
rejects('unsafe numeric evidence cannot enter canonical policy input', () => canonicalJson({ value: 1.5 }), /safe integers/)
rejects('oversize input is refused before evidence verification', () => decodePolicyRequest(' '.repeat(128 * 1024 + 1), opts), /exceeds/)
const forged = { ...source, content: 'changed after signing' }
rejects('tampered source evidence is refused', () => decodePolicyRequest(canonicalJson({ ...packet, evidence: { source_event: forged } }), opts), /signature or id/)
const edgeSource = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: 8_640_000_000_000, tags: [['e', watched]], content: 'last renderable instant' }, generateSecretKey())))
const edgeDecoded = decodePolicyRequest(canonicalJson({ ...packet, evidence: { source_event: edgeSource } }), opts)
t('the last ECMAScript-renderable source timestamp is accepted', quarantineSlotsFromSource(edgeDecoded.evidence.source_event).ts === edgeSource.created_at)
const beyondDateSource = JSON.parse(JSON.stringify(finalizeEvent({ kind: 1, created_at: 8_640_000_000_001, tags: [['e', watched]], content: 'signed but not renderable' }, generateSecretKey())))
rejects('a signed source timestamp beyond the catalogue Date boundary is refused', () => decodePolicyRequest(canonicalJson({ ...packet, evidence: { source_event: beyondDateSource } }), opts), /complete kind:1/)

const decision = decideQuarantineHeader(decoded, { stagingChannel: channel, watchedEventIds: [watched], approverMention: 'jafairweather' })
t('destination comes only from policy state', decision.dest === channel)
t('body and attribution come only from the signed source', decision.slots.body === source.content && decision.slots.id === source.id)
t('quarantine rendering uses the signed source timestamp without host clamping', decision.slots.ts === source.created_at && decision.slots.claimedTs === undefined)
t('quarantine rendering refuses relay-selected profile decoration', decision.slots.name === undefined && decision.slots.npub.startsWith('npub1'))
t('the local and remote paths share one byte projection', JSON.stringify(decision.slots) === JSON.stringify(quarantineSlotsFromSource(source, { approverMention: 'jafairweather' })))
t('the policy derives quarantine reason rather than accepting a route assertion', decision.slots.why === 'reply to our note')
rejects('an unrelated signed public note cannot be routed', () => decideQuarantineHeader(decoded, { stagingChannel: channel, watchedEventIds: ['f'.repeat(64)] }), /not a reply/)

const key = policyIdempotencyKey(decoded, decision)
t('idempotency key is stable and opaque', key === policyIdempotencyKey(decoded, decision) && /^[0-9a-f]{64}$/.test(key))
const otherDecision = decideQuarantineHeader(decoded, { stagingChannel: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', watchedEventIds: [watched] })
t('policy-resolved destination is part of idempotency', key !== policyIdempotencyKey(decoded, otherDecision))
rejects('a host-shaped decision cannot enter idempotency', () => policyIdempotencyKey(decoded, { ...decision }), /internally derived/)

console.log(fails ? `\noffbox_policy_core: ${fails} FAILED` : '\noffbox_policy_core: all checks passed')
process.exit(fails ? 1 : 0)
