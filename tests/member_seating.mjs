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

const { processGrantEvent, grantSet, revokedGrants, seatGrantee, seated, seatingCoverageGap, rosterRole, isElevated, seatingAuthority, PUB } = await import('../src/bridge.mjs')
const { emit, query, __setTransportForTests } = await import('../src/egress.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// The seam: every seat/unseat is captured instead of shelling out. `processGrantEvent` threads it
// through, so nothing here can reach a real `buzz` binary.
let calls = []
const capture = async (descriptor) => { calls.push(descriptor); return { stdout: '' } }
const drain = () => { const c = calls; calls = []; return c }

// The roster seam. Seating now READS before it writes: `--role member` against a key that already
// holds owner or admin is a demotion, not an idempotent re-add (#356 B2), and the only way to tell
// those apart is the roster. Every seat path therefore goes through this.
let roster = []                 // [{pubkey, role}] — what `channels members` prints
let rosterFails = null          // set to a message to make the read throw
const rosterQuery = async (name, params) => {
  if (name !== 'channel_members') throw new Error(`unexpected read verb ${JSON.stringify(name)}`)
  if (!params || !params.channel) throw new Error('roster read without a channel')
  if (rosterFails) throw new Error(rosterFails)
  return JSON.stringify(roster)
}
// seatGrantee awaits the roster before it emits, so a synchronous drain() after processGrantEvent
// would read an empty array and pass for the wrong reason. One place to await, so no call site can
// forget it silently.
const settle = () => new Promise(r => setImmediate(r))

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
await seatGrantee(secondAgentPk, capture, rosterQuery)
const control = drain()
ok('NEGATIVE CONTROL — the capture records a seat when one is genuinely made',
  control.length === 1 && control[0].template === 'member_seat')
seated.delete(secondAgentPk)   // release it so the idempotence check below starts clean

// --- direction 1: a valid grant seats the granted key, in the granted channel ------------------
const good = grantEvent(grantorSk, { grantee: agentPk })
processGrantEvent(good, { emitFn: capture, queryFn: rosterQuery })
await settle()          // seatGrantee is async; let it settle
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
processGrantEvent(good, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a replayed grant does not re-seat the same key', drain().length === 0)

// --- direction 2: the refusals. Each must refuse for its OWN reason ---------------------------
const forged = grantEvent(outsiderSk, { grantee: secondAgentPk })
processGrantEvent(forged, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a 440 signed by a NON-grantor neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const wrongChannel = grantEvent(grantorSk, { grantee: secondAgentPk, channel: OTHER_CHAN })
processGrantEvent(wrongChannel, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a 440 scoped to a DIFFERENT channel neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const wrongCap = grantEvent(grantorSk, { grantee: secondAgentPk, cap: 'task' })
processGrantEvent(wrongCap, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a 440 carrying a cap that is not admit neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

const tampered = { ...grantEvent(grantorSk, { grantee: secondAgentPk }), content: 'changed after signing' }
processGrantEvent(tampered, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a 440 whose signature no longer verifies neither admits nor seats',
  !grantSet.has(secondAgentPk) && drain().length === 0)

// …and the same fixture, minus the one defect, still gets through. Without this the four
// assertions above are equally satisfied by seating being broken outright.
const stillWorks = grantEvent(grantorSk, { grantee: secondAgentPk })
processGrantEvent(stillWorks, { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('a legitimate grant for that SAME key still seats — the refusals above are selective',
  grantSet.has(secondAgentPk) && drain().length === 1)

// --- revocation: the row loses its justification when the grant does --------------------------
processGrantEvent(revokeEvent(grantorSk, good.id), { emitFn: capture, queryFn: rosterQuery })
await settle()
const unseatCalls = drain()
ok('a 441 removes the admission', !grantSet.has(agentPk))
ok('…and unseats exactly that key', unseatCalls.length === 1 && unseatCalls[0].template === 'member_unseat' && unseatCalls[0].pubkey === agentPk)
ok('…and leaves the other admitted agent seated', grantSet.has(secondAgentPk))

// After the unseat, the same key may be admitted again — a stale `seated` entry would silently
// swallow the re-seat and leave them unnameable with a live grant.
processGrantEvent(grantEvent(grantorSk, { grantee: agentPk }), { emitFn: capture, queryFn: rosterQuery })
await settle()
ok('re-admitting a previously removed key seats it again', drain().length === 1)

// --- inert: configured on, but the channel never resolved -------------------------------------
// This is the failure that would otherwise be invisible. `--channel` takes a UUID; if boot left a
// friendly name in `inbox`, seating must refuse rather than emit an argv that cannot work.
const realInbox = PUB.inbox
PUB.inbox = 'waggle'
ok('seating refuses when inbox is an unresolved NAME rather than a UUID',
  (await seatGrantee(getPublicKey(generateSecretKey()), capture, rosterQuery)) === false && drain().length === 0)
PUB.inbox = realInbox

// --- off: the default. Nothing is emitted at all ----------------------------------------------
PUB.seatGrantees = false
ok('with seat_grantees off, an admitted key is NOT seated',
  (await seatGrantee(getPublicKey(generateSecretKey()), capture, rosterQuery)) === false && drain().length === 0)
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

// --- REPLAY ORDER. The case this suite never had, and the one that broke. ------------------------
// `pg` subscribes with `limit: 200` across both kinds, every relay replays independently, and
// nothing sorts by created_at. NIP-01 promises no delivery order at all, so a 441 arriving before
// its own 440 is the ordinary case on reconnect, not an exotic one. Fed that way the revocation
// loop matched an empty grantSet, removed nothing, and the 440 then admitted the key.
{
  const thirdSk = generateSecretKey(), thirdPk = getPublicKey(thirdSk)
  const g = grantEvent(grantorSk, { grantee: thirdPk })
  const r = revokeEvent(grantorSk, g.id)

  // Revocation FIRST — the order a relay is entirely free to choose.
  processGrantEvent(r, { emitFn: capture, queryFn: rosterQuery })
  await settle()
  ok('a 441 whose grant has not arrived yet removes nobody, because there is nobody to remove',
    !grantSet.has(thirdPk) && drain().length === 0)

  processGrantEvent(g, { emitFn: capture, queryFn: rosterQuery })
  await settle()
  ok('…and the 440 it revokes is REFUSED when it arrives, not admitted',
    !grantSet.has(thirdPk))
  ok('…so nothing is seated in the roster for a key whose grant was already revoked',
    drain().length === 0)
}
{
  // BOTH DIRECTIONS. Without this, the refusal above is equally satisfied by a bridge that has
  // stopped admitting anyone — and that failure would look identical on every assertion so far.
  const fourthSk = generateSecretKey(), fourthPk = getPublicKey(fourthSk)
  const g = grantEvent(grantorSk, { grantee: fourthPk })
  processGrantEvent(g, { emitFn: capture, queryFn: rosterQuery })
  await settle()
  ok('a grant that was NEVER revoked still admits, in the same run',
    grantSet.has(fourthPk))
  ok('…and still seats', drain().length === 1)
}
{
  // Oldest-first, the order everything used to assume. Must still work.
  const fifthSk = generateSecretKey(), fifthPk = getPublicKey(fifthSk)
  const g = grantEvent(grantorSk, { grantee: fifthPk })
  processGrantEvent(g, { emitFn: capture, queryFn: rosterQuery })
  await settle()
  const seatedOk = drain().length === 1 && grantSet.has(fifthPk)
  processGrantEvent(revokeEvent(grantorSk, g.id), { emitFn: capture, queryFn: rosterQuery })
  await settle()
  ok('in-order 440 then 441 still admits then removes', seatedOk && !grantSet.has(fifthPk))
  ok('…and unseats exactly once', drain().length === 1)
}
{
  // A revocation naming a grant id that is not ours must not poison an unrelated grant.
  const sixthSk = generateSecretKey(), sixthPk = getPublicKey(sixthSk)
  const other = grantEvent(grantorSk, { grantee: getPublicKey(generateSecretKey()) })
  processGrantEvent(revokeEvent(grantorSk, other.id), { emitFn: capture, queryFn: rosterQuery })
  await settle()
  drain()
  const mine = grantEvent(grantorSk, { grantee: sixthPk })
  processGrantEvent(mine, { emitFn: capture, queryFn: rosterQuery })
  await settle()
  ok('a revocation for a DIFFERENT grant does not block this one', grantSet.has(sixthPk))
  ok('…and it is seated normally', drain().length === 1)
  ok('the revoked-id set records the revocation it actually saw',
    revokedGrants.has(other.id) && !revokedGrants.has(mine.id))
}

// The read verb is subject to the same rule as the write ones: a descriptor that never becomes the
// right argv fails at the far end, where the only evidence is a stderr string.
{
  let readArgv = null
  const undo = __setTransportForTests(async (args) => { readArgv = args; return '[]' })
  await query('channel_members', { channel: CHAN })
  ok('the roster read becomes `channels members` argv, scoped to the channel',
    JSON.stringify(readArgv) === JSON.stringify(['channels', 'members', '--channel', CHAN]))
  let readRefused = null
  readArgv = null
  try { await query('channel_members', { channel: 'not a channel!! ../../etc' }) } catch (e) { readRefused = e.message }
  ok('…and a value that is not a channel is refused at the chokepoint, naming the type',
    readArgv === null && /channel/.test(String(readRefused)))
  undo()
}

// --- B2. The channel privilege the code never used to state ------------------------------------
// Both member verbs are gated on a role, and each way it resolves is its own defect: not elevated
// and every UNSEAT fails, so a revoked grant's row survives; elevated and `--role member` against
// an owner is an authorised DEMOTION. Neither is "bounded only by a grant it verified itself".

// The pure half first — the roster JSON is what both guards actually reason over, and a parser
// that quietly returns null for everything would make every guard below vacuous.
const ROSTER = JSON.stringify([
  { pubkey: 'AA'.repeat(32), role: 'owner' },
  { pubkey: 'bb'.repeat(32), role: 'admin' },
  { pubkey: 'cc'.repeat(32), role: 'member' },
  { pubkey: 'dd'.repeat(32), role: '' },
])
ok('rosterRole reads a role out of the roster', rosterRole(ROSTER, 'cc'.repeat(32)) === 'member')
ok('…case-insensitively on the pubkey, since Buzz prints hex either way',
  rosterRole(ROSTER, 'aa'.repeat(32)) === 'owner' && rosterRole(ROSTER, 'BB'.repeat(32)) === 'admin')
ok('…and an empty role reads as member, exactly as Buzz defaults it',
  rosterRole(ROSTER, 'dd'.repeat(32)) === 'member')
ok('a key that is NOT in the roster is null, which is not the same as member',
  rosterRole(ROSTER, 'ee'.repeat(32)) === null)
ok('malformed roster JSON is null rather than a throw', rosterRole('not json at all', 'aa'.repeat(32)) === null)
ok('a JSON scalar where an array was expected is null', rosterRole('42', 'aa'.repeat(32)) === null)
ok('isElevated is true for exactly owner and admin',
  isElevated('owner') && isElevated('ADMIN') && !isElevated('member') && !isElevated('guest') && !isElevated('') && !isElevated(null))

// The seat guard. Direction 1: an already-elevated target is left alone.
{
  const ownerPk = getPublicKey(generateSecretKey())
  roster = [{ pubkey: ownerPk, role: 'owner' }]
  const wrote = await seatGrantee(ownerPk, capture, rosterQuery)
  ok('a key that already holds owner is NOT seated at member — that would be a demotion',
    wrote === false && drain().length === 0)
  ok('…and it is marked seated, so the replay does not re-attempt it every reconnect',
    seated.has(ownerPk))

  const adminPk = getPublicKey(generateSecretKey())
  roster = [{ pubkey: adminPk, role: 'admin' }]
  ok('the same holds for admin', (await seatGrantee(adminPk, capture, rosterQuery)) === false && drain().length === 0)
}
// Direction 2, and the one that makes the two above mean something: an ordinary key still gets in.
// Without this, "refuses to demote an owner" is indistinguishable from "refuses everything".
{
  const plainPk = getPublicKey(generateSecretKey())
  roster = [{ pubkey: 'ff'.repeat(32), role: 'owner' }]           // an owner IS present, just not this key
  ok('a key that is not in the roster at all is seated normally',
    (await seatGrantee(plainPk, capture, rosterQuery)) === true && drain().length === 1)

  const memberPk = getPublicKey(generateSecretKey())
  roster = [{ pubkey: memberPk, role: 'member' }]
  ok('…and so is one already sitting at member — a re-add at the same role is idempotent',
    (await seatGrantee(memberPk, capture, rosterQuery)) === true && drain().length === 1)
}
// Fail CLOSED. An unreadable roster cannot prove the target is not an owner, so it is a refusal —
// and NOT marked seated, because the next replay must retry once the read works again.
{
  const unknownPk = getPublicKey(generateSecretKey())
  rosterFails = 'buzz: connection refused'
  const wrote = await seatGrantee(unknownPk, capture, rosterQuery)
  rosterFails = null
  ok('an unreadable roster REFUSES the seat rather than assuming member',
    wrote === false && drain().length === 0)
  ok('…and does not mark it seated, so the next replay retries', !seated.has(unknownPk))
  ok('…and the same key seats once the roster is readable again',
    (await seatGrantee(unknownPk, capture, rosterQuery)) === true && drain().length === 1)
}

// The boot precondition. Four states, because collapsing "could not read" into "not elevated"
// reports a definite failure from an inconclusive probe — the thing this repo exits 3 for.
{
  const me = 'ab'.repeat(32)
  const q = (rows) => async () => JSON.stringify(rows)
  const elevated = await seatingAuthority(CHAN, me, q([{ pubkey: me, role: 'admin' }]))
  ok('waggle holding admin reads as CAN ACT, and the line names the role it saw',
    elevated.state === 'elevated' && /admin/.test(elevated.why))
  const owner = await seatingAuthority(CHAN, me, q([{ pubkey: me, role: 'owner' }]))
  ok('…owner too', owner.state === 'elevated')
  const plain = await seatingAuthority(CHAN, me, q([{ pubkey: me, role: 'member' }]))
  ok('waggle holding member reads as CANNOT ACT, naming the role rather than just refusing',
    plain.state === 'not-elevated' && /member/.test(plain.why))
  const absent = await seatingAuthority(CHAN, me, q([{ pubkey: 'cd'.repeat(32), role: 'owner' }]))
  ok('waggle missing from the roster is its OWN state, not "member"',
    absent.state === 'absent' && /not in this roster/.test(absent.why))
  const blind = await seatingAuthority(CHAN, me, async () => { throw new Error('relay timeout') })
  ok('a roster read that fails is UNREADABLE, not a verdict — inconclusive is not a pass',
    blind.state === 'unreadable' && /relay timeout/.test(blind.why))
}

restore()
console.log(fails ? `\nMEMBER SEATING FAIL — ${fails}` : '\nMEMBER SEATING PASS — the roster is a projection of the grant set, in both directions')
process.exit(fails ? 1 : 0)
