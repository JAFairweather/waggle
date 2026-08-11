// #355 — an admitted agent is SEATED in the channel roster, so a crew member can name it.
//
// The property is a projection, and a projection has two directions. A test that only proved
// "a valid grant seats" could not tell "seats the granted key" from "seats anything at all", and
// a test that only proved "a forged grant does not seat" could not tell "refuses the forgery" from
// "seating is broken". Both directions are asserted here, and the argv that actually reaches the
// Buzz CLI is asserted too — because a descriptor that never becomes the right argv is a carry
// that fails at the far end, where the only evidence is a stderr string.
//
//   node tests/member_seating.mjs

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-seating-'))
const bridgeSk = generateSecretKey()
const grantorSk = generateSecretKey()
const grantorPk = getPublicKey(grantorSk)
const outsiderSk = generateSecretKey()          // signs a 440 nobody authorised
const agentPk = getPublicKey(generateSecretKey())
const secondAgentPk = getPublicKey(generateSecretKey())
// A real channel UUID shape. `--channel` takes a UUID and boot resolves a name into one, so a
// fixture using a friendly name would exercise a code path production never runs.
const CHAN = '3f2b9c14-7d0e-4a58-9b61-c8ee4a70d215'
const OTHER_CHAN = 'a1c7e930-55b2-4f6d-8e04-2d9f7b1c6a83'

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CHAN, staging_inbox: CHAN, watch_authors: [], watch_events: [],
    grantors: [grantorPk], return_lane: [], seat_grantees: true,
  },
}))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_NO_BOOT = '1'

const { processGrantEvent, grantSet, seatGrantee, seated, seatingCoverageGap, PUB } = await import('../src/bridge.mjs')
const { emit, __setTransportForTests } = await import('../src/egress.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// The seam: every seat/unseat is captured instead of shelling out. `processGrantEvent` threads it
// through, so nothing here can reach a real `buzz` binary.
let calls = []
const capture = async (descriptor) => { calls.push(descriptor); return { stdout: '' } }
const drain = () => { const c = calls; calls = []; return c }

const wire = ev => JSON.parse(JSON.stringify(ev))
const scopeFor = (channel) => {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(Buffer.concat([
    Buffer.from('waggle/da-scope/v1'), Buffer.from([0]), Buffer.from(channel), Buffer.from(salt, 'hex'),
  ])).digest('hex')
  return [hash, salt]
}
const grantEvent = (sk, { grantee, channel = CHAN, cap = 'admit' } = {}) => wire(finalizeEvent({
  kind: 440, created_at: Math.floor(Date.now() / 1000),
  tags: [['p', grantee], ['da-scope', ...scopeFor(channel)], ['da-cap', cap]], content: '',
}, sk))
const revokeEvent = (sk, grantId) => wire(finalizeEvent({
  kind: 441, created_at: Math.floor(Date.now() / 1000), tags: [['e', grantId]], content: '',
}, sk))

// --- the harness itself, before anything is concluded from its silence ------------------------
// A capture that never fires and a guard that never passes look identical from the outside. So:
// prove the capture fires at all, on a direct call, before treating an empty `calls` as evidence.
await seatGrantee(secondAgentPk, capture)
const control = drain()
ok('NEGATIVE CONTROL — the capture records a seat when one is genuinely made',
  control.length === 1 && control[0].template === 'member_seat')
seated.delete(secondAgentPk)   // release it so the idempotence check below starts clean

// --- direction 1: a valid grant seats the granted key, in the granted channel ------------------
const good = grantEvent(grantorSk, { grantee: agentPk })
processGrantEvent(good, { emitFn: capture })
await new Promise(r => setImmediate(r))          // seatGrantee is async; let it settle
const seatCalls = drain()
ok('a grant from a configured grantor admits the key', grantSet.has(agentPk))
ok('…and seats it — exactly one add-member', seatCalls.length === 1 && seatCalls[0].template === 'member_seat')
ok('…in the channel the grant was scoped to', seatCalls[0]?.dest === CHAN)
ok('…naming the granted key, not some other one', seatCalls[0]?.pubkey === agentPk)

// The descriptor is not the thing Buzz sees. This is.
let argv = null
const restore = __setTransportForTests(async (args) => { argv = args; return '' })
await emit({ template: 'member_seat', dest: CHAN, pubkey: agentPk })
ok('the seat descriptor becomes `channels add-member` argv',
  JSON.stringify(argv) === JSON.stringify(['channels', 'add-member', '--channel', CHAN, '--pubkey', agentPk, '--role', 'member']))
argv = null
await emit({ template: 'member_unseat', dest: CHAN, pubkey: agentPk })
ok('the unseat descriptor becomes `channels remove-member` argv',
  JSON.stringify(argv) === JSON.stringify(['channels', 'remove-member', '--channel', CHAN, '--pubkey', agentPk]))
// A pubkey that is not 64-char hex must be refused HERE, at the chokepoint — not at the CLI, where
// it costs a round trip and returns prose. An npub is the realistic wrong value: `npub` (the slot
// type used for --mention) accepts it, and reaching for that type here would have been natural.
argv = null
let refused = null
try { await emit({ template: 'member_seat', dest: CHAN, pubkey: 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsuc0ns' }) }
catch (e) { refused = e.message }
ok('an npub is refused at the chokepoint, and the refusal says which type refused it',
  argv === null && /pubkey_hex/.test(String(refused)))

// --- replay: the same grant arrives again on every relay reconnect ----------------------------
processGrantEvent(good, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a replayed grant does not re-seat the same key', drain().length === 0)

// --- direction 2: the refusals. Each must refuse for its OWN reason ---------------------------
const forged = grantEvent(outsiderSk, { grantee: secondAgentPk })
processGrantEvent(forged, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a 440 signed by a NON-grantor neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const wrongChannel = grantEvent(grantorSk, { grantee: secondAgentPk, channel: OTHER_CHAN })
processGrantEvent(wrongChannel, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a 440 scoped to a DIFFERENT channel neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const wrongCap = grantEvent(grantorSk, { grantee: secondAgentPk, cap: 'task' })
processGrantEvent(wrongCap, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a 440 carrying a cap that is not admit neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const tampered = { ...grantEvent(grantorSk, { grantee: secondAgentPk }), content: 'changed after signing' }
processGrantEvent(tampered, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a 440 whose signature no longer verifies neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

// …and the same fixture, minus the one defect, still gets through. Without this the four
// assertions above are equally satisfied by seating being broken outright.
const stillWorks = grantEvent(grantorSk, { grantee: secondAgentPk })
processGrantEvent(stillWorks, { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('a legitimate grant for that SAME key still seats — the refusals above are selective',
  grantSet.has(secondAgentPk) && drain().length === 1)

// --- revocation: the row loses its justification when the grant does --------------------------
processGrantEvent(revokeEvent(grantorSk, good.id), { emitFn: capture })
await new Promise(r => setImmediate(r))
const unseatCalls = drain()
ok('a 441 removes the admission', !grantSet.has(agentPk))
ok('…and unseats exactly that key', unseatCalls.length === 1 && unseatCalls[0].template === 'member_unseat' && unseatCalls[0].pubkey === agentPk)
ok('…and leaves the other admitted agent seated', grantSet.has(secondAgentPk))

// After the unseat, the same key may be admitted again — a stale `seated` entry would silently
// swallow the re-seat and leave them unnameable with a live grant.
processGrantEvent(grantEvent(grantorSk, { grantee: agentPk }), { emitFn: capture })
await new Promise(r => setImmediate(r))
ok('re-admitting a previously removed key seats it again', drain().length === 1)

// --- inert: configured on, but the channel never resolved -------------------------------------
// This is the failure that would otherwise be invisible. `--channel` takes a UUID; if boot left a
// friendly name in `inbox`, seating must refuse rather than emit an argv that cannot work.
const realInbox = PUB.inbox
PUB.inbox = 'waggle'
ok('seating refuses when inbox is an unresolved NAME rather than a UUID',
  (await seatGrantee(getPublicKey(generateSecretKey()), capture)) === false && drain().length === 0)
PUB.inbox = realInbox

// --- off: the default. Nothing is emitted at all ----------------------------------------------
PUB.seatGrantees = false
ok('with seat_grantees off, an admitted key is NOT seated',
  (await seatGrantee(getPublicKey(generateSecretKey()), capture)) === false && drain().length === 0)
PUB.seatGrantees = true

// --- nameable is not the same as reachable ----------------------------------------------------
// Seating writes the roster in `inbox`; carries come from `scan_channels`. Where they differ the
// agent is nameable in a channel nothing watches, and the failure is invisible from every side:
// the message lands, the at-word resolves, and the carry simply never happens.
ok('a scan set that covers the roster channel is NOT flagged', seatingCoverageGap(CHAN, [CHAN]) === false)
ok('…case-insensitively, since a UUID may arrive either way', seatingCoverageGap(CHAN.toUpperCase(), [CHAN]) === false)
ok('…and still not flagged when other channels are watched too', seatingCoverageGap(CHAN, [OTHER_CHAN, CHAN]) === false)
ok('a scan set that watches a DIFFERENT channel is flagged', seatingCoverageGap(CHAN, [OTHER_CHAN]) === true)
ok('an empty scan set is flagged', seatingCoverageGap(CHAN, []) === true)
ok('a missing scan set is flagged rather than throwing', seatingCoverageGap(CHAN, undefined) === true)
ok('an empty roster channel is flagged — it cannot be covered by anything', seatingCoverageGap('', [CHAN]) === true)

restore()
console.log(fails ? `\nMEMBER SEATING FAIL — ${fails}` : '\nMEMBER SEATING PASS — the roster is a projection of the grant set, in both directions')
process.exit(fails ? 1 : 0)
