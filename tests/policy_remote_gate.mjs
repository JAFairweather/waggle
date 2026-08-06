import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { canonicalJson } from '../src/buzz_policy_core.mjs'

let fails = 0
const ok = (name, pass) => { console.log(`${pass ? 'ok  ' : 'FAIL'} — ${name}`); if (!pass) fails++ }
const wire = value => JSON.parse(JSON.stringify(value))
const tmp = mkdtempSync(join(tmpdir(), 'waggle-policy-remote-'))
const watched = 'd'.repeat(64), staging = 'a8186b53-537d-46ad-a7e7-b6486c58970e'
const inbox = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', catalogue = 'c'.repeat(64)
const signer = generateSecretKey(), poster = getPublicKey(signer), endpoint = 'buzz.example'
const trustedSigner = generateSecretKey(), trusted = getPublicKey(trustedSigner)
const directRecipient = getPublicKey(generateSecretKey()), directInbox = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const config = { relays: [], recipients: [{ npub_hex: directRecipient, name: 'Codex Test', inbox: directInbox }], public: {
  relays: [], inbox, staging_inbox: staging, watch_authors: [], watch_events: [watched], approvers: [],
  trusted_repliers: [trusted],
  policy_writer: { mode: 'remote-only', operations: ['quarantine_header', 'standing_trusted_reply', 'sealed_direct_envelope'], policy_instance: 'jaf-hive', catalogue_version: catalogue,
    poster_pubkey: poster, endpoint_authority: endpoint, ssh_host: 'policy.example',
    ssh_user: 'waggle-policy-ingress', ssh_identity_file: '/etc/waggle/policy-client/writer_ed25519',
    ssh_known_hosts_file: '/etc/waggle/policy-client/known_hosts' },
} }
writeFileSync(join(tmp, 'config.json'), JSON.stringify(config))
process.env.WB_NO_BOOT = '1'
process.env.WB_STUB_SEND = '1'
process.env.FORWARD_MODE = 'buzz'
process.env.CONFIG_PATH = join(tmp, 'config.json')
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.POSTED_MAP_PATH = join(tmp, 'posted.log')
process.env.SEND_JOURNAL_PATH = join(tmp, 'send.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')
process.env.POLICY_REQUEST_QUEUE_PATH = join(tmp, 'policy-requests')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(generateSecretKey()).toString('hex')

// The sealed bridge supports recipients-only (DM-only) configurations. Policy migration is a
// public-lane option, so merely shipping the new operation must remain inert for that legacy
// shape. Exercise this in a child because bridge configuration is intentionally fixed at import.
const legacyConfigPath = join(tmp, 'legacy-config.json')
writeFileSync(legacyConfigPath, JSON.stringify({ relays: [], recipients: [
  { npub_hex: directRecipient, name: 'Legacy DM Seat', inbox: directInbox },
] }))
const legacyWrap = wire(finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000),
  tags: [['p', directRecipient]], content: 'legacy-opaque-ciphertext' }, generateSecretKey()))
const bridgeUrl = pathToFileURL(join(process.cwd(), 'src', 'bridge.mjs')).href
const legacyProbe = spawnSync(process.execPath, ['--input-type=module', '-e',
  `const { route } = await import(${JSON.stringify(bridgeUrl)}); route(JSON.parse(process.env.TEST_WRAP)); console.log('legacy-route-ok')`], {
  cwd: process.cwd(), encoding: 'utf8', env: { ...process.env,
    CONFIG_PATH: legacyConfigPath, TEST_WRAP: JSON.stringify(legacyWrap),
    SEEN_PATH: join(tmp, 'legacy-seen.log'), POSTED_MAP_PATH: join(tmp, 'legacy-posted.log'),
    SEND_JOURNAL_PATH: join(tmp, 'legacy-send.log'), PUB_WATERMARK_PATH: join(tmp, 'legacy-watermark'),
    POLICY_REQUEST_QUEUE_PATH: join(tmp, 'legacy-policy-requests'),
  },
})
if (legacyProbe.status !== 0) console.error(legacyProbe.stderr || legacyProbe.stdout)
ok('a recipients-only legacy config routes a direct wrap without touching public policy state',
  legacyProbe.status === 0 && legacyProbe.stdout.includes('legacy-route-ok') && !legacyProbe.stderr.includes('TypeError'))

const B = await import('../src/bridge.mjs')
const { route, routePublic, seen, postedMap, policyRequests, policyWriterInFlight, PUB,
  retryRemotePolicyRequests, processRemotePolicyRequest, __setPolicyWriterRunnerForTests,
  unframePolicyWriterResponse } = B
policyRequests.load()
const note = (content, key = generateSecretKey()) => wire(finalizeEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000),
  tags: [['e', watched]], content }, key))
const response = (raw, result = 'accepted') => {
  const request = JSON.parse(raw), source = request.evidence.source_event
  const requestDigest = createHash('sha256').update(raw).digest('hex')
  const operation = request.operation
  const channel = operation === 'sealed_direct_envelope' ? directInbox : operation === 'standing_trusted_reply' ? inbox : staging
  const key = createHash('sha256').update(canonicalJson([1, 'jaf-hive', catalogue,
    operation, [source.id], channel])).digest('hex')
  const accepted = result === 'accepted', completed = Math.floor(Date.now() / 1000)
  const fields = { version: 1, policy_instance: 'jaf-hive', operation,
    catalogue_version: catalogue, request_digest: requestDigest, idempotency_key: key,
    source_ids: [source.id], buzz_channel: channel, endpoint_authority: endpoint,
    buzz_event_id: accepted ? 'b'.repeat(64) : 'e'.repeat(64), result,
    reason_code: accepted ? 'accepted' : 'relay_refused', response_digest: 'f'.repeat(64), completed_at: completed }
  const receipt = wire(finalizeEvent({ kind: 30078, created_at: completed,
    tags: [['d', `waggle-policy:${key}`]], content: canonicalJson(fields) }, signer))
  return `${canonicalJson({ status: 'terminal', result, receipt: canonicalJson(receipt) })}\n`
}
const wait = async () => { for (let i = 0; i < 200 && policyWriterInFlight.size; i++) await new Promise(resolve => setTimeout(resolve, 5)) }

let calls = 0, firstRaw = ''
__setPolicyWriterRunnerForTests(async raw => {
  calls++; firstRaw = raw
  ok('the exact request is durable before the remote writer is invoked',
    existsSync(join(tmp, 'policy-requests', `${JSON.parse(raw).evidence.source_event.id}.request`)))
  await new Promise(resolve => setTimeout(resolve, 10))
  return `${canonicalJson({ status: 'held', result: null, receipt: null })}\n`
})
const held = note('held remote-only')
routePublic(held); routePublic(held); await wait()
ok('duplicate relay delivery collapses to one remote policy call', calls === 1)
ok('held policy work remains durable, unseen, and never reaches the local sender', policyRequests.has(held.id) && !seen.has(held.id) && !postedMap.has(held.id))

let retryRaw = ''
__setPolicyWriterRunnerForTests(async raw => { retryRaw = raw; return response(raw) })
retryRemotePolicyRequests(); await wait()
ok('retry uses byte-identical request bytes after the hold', firstRaw === retryRaw)
ok('a verified accepted receipt closes debt and records the off-box Buzz event', !policyRequests.has(held.id) && seen.has(held.id) && postedMap.get(held.id)?.buzz === 'b'.repeat(64))
ok('the off-box event enters the durable tripwire journal', readFileSync(join(tmp, 'send.log'), 'utf8').includes('"lane":"public-policy"'))

let standingRaw = ''
__setPolicyWriterRunnerForTests(async raw => { standingRaw = raw; return response(raw) })
const standing = note('standing trusted reply', trustedSigner)
routePublic(standing); await wait()
ok('standing trusted reply selects its distinct off-box operation', JSON.parse(standingRaw).operation === 'standing_trusted_reply')
ok('standing trusted reply reaches the policy-owned inbox as released content',
  postedMap.get(standing.id)?.dest === inbox && postedMap.get(standing.id)?.q === false)

let standingRetryRaw = ''
__setPolicyWriterRunnerForTests(async raw => {
  standingRetryRaw = raw
  return `${canonicalJson({ status: 'held', result: null, receipt: null })}\n`
})
const standingHeld = note('standing restart debt', trustedSigner)
routePublic(standingHeld); await wait()
const standingHeldRaw = standingRetryRaw
ok('a held standing reply is durable before restart', policyRequests.has(standingHeld.id))
PUB.staging = null
__setPolicyWriterRunnerForTests(async raw => { standingRetryRaw = raw; return response(raw) })
const retriedWithoutStaging = retryRemotePolicyRequests(); await wait()
ok('restart retries inbox-bound standing debt when staging is absent',
  retriedWithoutStaging === 1 && standingRetryRaw === standingHeldRaw && !policyRequests.has(standingHeld.id) && seen.has(standingHeld.id))
PUB.staging = staging

let sealedRaw = ''
__setPolicyWriterRunnerForTests(async raw => { sealedRaw = raw; return response(raw) })
const directWrap = wire(finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000),
  tags: [['p', directRecipient]], content: 'opaque-ciphertext' }, generateSecretKey()))
route(directWrap); await wait()
ok('a direct signed gift wrap selects the off-box sealed operation',
  JSON.parse(sealedRaw).operation === 'sealed_direct_envelope')
ok('an accepted sealed receipt commits dedup and the sealed tripwire without creating a public posted-map row',
  seen.has(directWrap.id) && !policyRequests.has(directWrap.id) && !postedMap.has(directWrap.id) &&
  readFileSync(join(tmp, 'send.log'), 'utf8').includes('"lane":"sealed-policy"'))

const callsBeforeDecoy = calls
const decoyWrap = wire(finalizeEvent({ kind: 1059, created_at: Math.floor(Date.now() / 1000),
  tags: [['p', directRecipient], ['p', getPublicKey(generateSecretKey())]], content: 'recipient-decoy' }, generateSecretKey()))
route(decoyWrap); await wait()
ok('a direct wrap with one roster recipient plus a decoy is terminally dropped before remote queueing',
  calls === callsBeforeDecoy && seen.has(decoyWrap.id) && !policyRequests.has(decoyWrap.id))

const forged = note('forged response')
__setPolicyWriterRunnerForTests(async raw => {
  const parsed = JSON.parse(response(raw)); const receipt = JSON.parse(parsed.receipt)
  receipt.sig = `${receipt.sig[0] === '0' ? '1' : '0'}${receipt.sig.slice(1)}`
  return `${canonicalJson({ ...parsed, receipt: canonicalJson(receipt) })}\n`
})
routePublic(forged); await wait()
ok('a forged receipt remains owed and cannot trigger local fallback', policyRequests.has(forged.id) && !seen.has(forged.id) && !postedMap.has(forged.id))

const rejected = note('terminal reject')
__setPolicyWriterRunnerForTests(async raw => response(raw, 'rejected'))
routePublic(rejected); await wait()
ok('a verified terminal refusal is handled without a Buzz post or local fallback', seen.has(rejected.id) && !policyRequests.has(rejected.id) && !postedMap.has(rejected.id))

let framed = false
try { unframePolicyWriterResponse('{"status":"held"}\n{"smuggled":true}\n') } catch { framed = true }
ok('multi-line writer output cannot smuggle a second response', framed)
let mismatchCalls = 0
__setPolicyWriterRunnerForTests(async raw => { mismatchCalls++; return response(raw) })
await processRemotePolicyRequest('f'.repeat(64), firstRaw)
ok('a queue filename cannot be rebound to another signed source event', mismatchCalls === 0)

console.log(fails ? `\npolicy_remote_gate: ${fails} FAILED` : '\npolicy_remote_gate: all checks passed')
process.exit(fails ? 1 : 0)
