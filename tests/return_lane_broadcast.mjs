// Return-lane BROADCAST — the #wagglebroadcast room marker (#337).
//
// The problem this exists for: two agents admitted to the same channel could each post and each be
// read by the community, and still not reach each other. The maintainer was hand-copying messages in
// both directions. The marker gives an admitted participant one way to reach the others.
//
// It carries NO ROSTER. A discovery payload naming the other grant-holders was written and withdrawn
// under review: it read grantSet unfiltered while delivery applied the managed-route channel binding
// first (so it could name someone nothing was carried to), and it leaked the room partition that the
// salted da-scope exists to hide. Discovery needs its own design, not a slot on the carry prose.
//
// What this proves, in both directions every time (a guard asserted only on what it refuses cannot
// be told apart from a guard that refuses everything — CLAUDE.md, earned 2026-08-01):
//
//   • a granted participant's #wagglebroadcast fans out to EVERY other admitted participant,
//     and to nobody who holds no grant,
//   • an UNGRANTED author's identical message fans out to nobody — and says so, loudly,
//   • the broadcaster never receives their own broadcast, including via the shared bridge signer
//     (the registry, not the Buzz pubkey, is what identifies them),
//   • a plain message with no marker still carries nothing — the marker is doing the work, not the
//     grant,
//   • #wagglebroadcasting does NOT trigger (word boundary), and #WaggleBroadcast does (case),
//   • precedence: a message that both names you and carries the marker is a 'mention', not a
//     'broadcast' — you were addressed personally,
//   • a revoked grant (441) removes a key from the fan-out in the same pass,
//   • a broadcast fires ONLY in the channel admission grants are scoped to — grants verify against
//     scopeHash(PUB.inbox), while broadcasts fire while draining PUB.scanChannels, and nothing
//     compared the two until review did,
//   • the managed-route CHANNEL binding still holds,
//   • a typed task route is SKIPPED, because its v:1 consumer hard-drops reason=broadcast,
//   • re-scanning the same broadcast carries nothing new and does not spend the rate cap again.
//
//   node tests/return_lane_broadcast.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey, finalizeEvent } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-rlb-'))
const bridgeSk = generateSecretKey()

// The channel a grant is scoped to, a second watched channel that no grant covers, and the staging
// room. Distinct on purpose — see the config comment below.
// Real UUIDs, not names: the deployed channels are UUIDs, and the typed task-carry contract refuses
// anything else. A name-shaped fixture silently excluded typed routes from every assertion here.
const INBOX = '11111111-1111-4111-8111-111111111111'
const FIELD = '22222222-2222-4222-8222-222222222222'
const STAGING = '33333333-3333-4333-8333-333333333333'

// Three external agents. mcclaude and oliver are the real shape of the problem: both admitted,
// neither knowing the other exists. legacy is a configured route that holds NO grant — it must keep
// its mentions and be absent from every broadcast.
const mcclaude = getPublicKey(generateSecretKey())
const oliver = getPublicKey(generateSecretKey())
const bumble = getPublicKey(generateSecretKey())
const legacy = getPublicKey(generateSecretKey())

// Buzz-side signers. sharedSigner stands in for the bridge's own posting key: it is bound to more
// than one entry, so it is ambiguous and must never drive echo-skip on its own.
const sharedSignerSk = generateSecretKey()
const sharedSigner = getPublicKey(sharedSignerSk)
const crewSk = generateSecretKey()
const crew = getPublicKey(crewSk)
const signerKeys = new Map([[crew, crewSk], [sharedSigner, sharedSignerSk]])

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    // FOUR INDEPENDENT VALUES, FOUR DISTINCT CONSTANTS. They were all `chan` in the first version
    // of this file, and that single line was the root cause of two shipped defects that review
    // caught and this suite did not: the grant scope (`inbox`) and the scanned channel are separate
    // config keys that nothing compares, and collapsing them made a broadcast look room-scoped
    // when it was not. A fixture that cannot tell two values apart cannot test the relationship
    // between them.
    relays: ['wss://example.invalid'], inbox: INBOX, staging_inbox: STAGING,
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [crew, sharedSigner], scan_channels: [INBOX, FIELD],
    return_lane: [
      { npub_hex: legacy, mention: 'legacy', authors: [sharedSigner] },
    ],
  },
}, null, 2))

process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'return-lane-seen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'
// A small breaker threshold so the loop test exercises the real mechanism rather than a mock of it.
// Set BEFORE the import that reads it — a value applied afterwards would leave the suite asserting
// the default and passing for the wrong reason.
const PAIR_MAX = 4
process.env.RL_PAIR_MAX = String(PAIR_MAX)

const { scanReturnLane, recordPosted, PUB, grantSet, BROADCAST_MARKER } =
  await import('../src/bridge.mjs')
const { buildBody } = await import('../src/nostr_egress.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []

// The bridge only logs a 12-char prefix of the recipient to the journal, so that is the identity
// this suite compares on — same convention as return_lane_scan.mjs.
const short = k => k.slice(0, 12)

// The drop lines are the other half of the contract: a refusal nobody can read is a silent drop.
const stderr = []
const realErr = process.stderr.write.bind(process.stderr)
process.stderr.write = (chunk, ...rest) => { stderr.push(String(chunk)); return realErr(chunk, ...rest) }

let msgSeq = 0
async function scanDelta(msgs, opts) {
  const before = journal().filter(row => row.lane === 'return').length
  stderr.length = 0
  const wire = msgs.map((m) => {
    // An already-signed event passes through UNTOUCHED. Re-signing it would mint a new id, and the
    // agent-authored registry is keyed on the id — a silently re-signed fixture would look exactly
    // like a broadcast the bridge refused, which is what it did the first time this ran.
    if (m.sig) return m
    const sk = signerKeys.get(m.pubkey)
    if (!sk) return m
    return JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 2000 + (msgSeq++),
      tags: m.tags || [], content: String(m.content || '') }, sk)))
  })
  if (opts === undefined) await scanReturnLane(wire)
  else await scanReturnLane(wire, opts)
  const j = journal().filter(row => row.lane === 'return')
  return { rows: j.slice(before), wire, log: stderr.join('') }
}

// Admit the three agents. `legacy` is deliberately left out.
const grantOf = (pk, n) => grantSet.set(pk, { grantId: String(n).repeat(64).slice(0, 64), grantor: crew })
grantOf(mcclaude, 1); grantOf(oliver, 2); grantOf(bumble, 3)

// --- the marker itself, as a value -------------------------------------------------------------
ok('the marker matches #wagglebroadcast', BROADCAST_MARKER.test('please read this #wagglebroadcast'))
ok('the marker matches at the start of a line', BROADCAST_MARKER.test('#wagglebroadcast hello room'))
ok('the marker is case-insensitive', BROADCAST_MARKER.test('#WaggleBroadcast'))
ok('NEGATIVE CONTROL — #wagglebroadcasting does NOT match (word boundary)',
  !BROADCAST_MARKER.test('we are #wagglebroadcasting today'))
ok('NEGATIVE CONTROL — #wagglebroadcast-v2 does NOT match', !BROADCAST_MARKER.test('#wagglebroadcast-v2'))
ok('NEGATIVE CONTROL — a plain sentence does not match', !BROADCAST_MARKER.test('broadcast this to waggle'))

// --- a granted participant broadcasts ------------------------------------------------------------
// The realistic shape: oliver's words reach Buzz via the relay lane, so the kind:9 is signed by the
// SHARED bridge key and only the per-event registry knows whose words they are.
{
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3000, tags: [],
    content: 'is anyone else here? #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b1', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  const to = rows.map(r => r.to).sort()
  ok('a granted broadcast reaches the OTHER admitted participants',
    JSON.stringify(to) === JSON.stringify([short(mcclaude), short(bumble)].sort()))
  ok('the broadcaster does not receive their own broadcast', !to.includes(short(oliver)))
  ok('a configured route holding no grant is NOT in the fan-out', !to.includes(short(legacy)))
  ok('every carry is labelled broadcast', rows.length > 0 && rows.every(r => r.why === 'broadcast'))
}

// --- NEGATIVE CONTROL: the same message from an UNGRANTED author --------------------------------
{
  const { rows, log } = await scanDelta([{ id: 'b2', pubkey: crew,
    content: 'is anyone else here? #wagglebroadcast' }], { authors: PUB.scanAuthors, channel: INBOX })
  ok('an ungranted author\'s #wagglebroadcast fans out to nobody', rows.length === 0)
  // Loud, not silent: a member who types the marker and gets nothing must be able to find out why.
  ok('the refusal names the marker and says no grant', /drop\[broadcast\]/.test(log) && /admission grant/.test(log))
}

// --- NEGATIVE CONTROL: a granted author with NO marker ------------------------------------------
{
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3100, tags: [],
    content: 'just thinking out loud, nobody in particular' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b3', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  ok('a granted author WITHOUT the marker fans out to nobody — the marker is doing the work',
    rows.length === 0)
}

// --- NEGATIVE CONTROL: the near-miss word ------------------------------------------------------
{
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3200, tags: [],
    content: 'we are #wagglebroadcasting the results later' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b4', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  ok('#wagglebroadcasting does not fan out', rows.length === 0)
}

// --- precedence: a personal mention outranks the room --------------------------------------------
{
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3300,
    tags: [['p', mcclaude]], content: 'mcclaude specifically, and everyone #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b5', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  const byTo = Object.fromEntries(rows.map(r => [r.to, r.why]))
  ok('the p-tagged recipient is told they were MENTIONED, not broadcast to', byTo[short(mcclaude)] === 'mention')
  ok('everyone else in the room is still told it was a broadcast', byTo[short(bumble)] === 'broadcast')
}

// --- dedup: a re-scan carries nothing new -------------------------------------------------------
{
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3400, tags: [],
    content: 'second call #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b6', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const first = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  ok('the broadcast lands once', first.rows.length === 2)
  const again = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  ok('re-scanning the same broadcast carries nothing new', again.rows.length === 0)
  ok('the overlap re-read did not spend the rate cap', !/BROADCAST drop\[rate\]/.test(again.log))
}

// --- revocation removes a key from the fan-out in the same pass ---------------------------------
{
  grantSet.delete(bumble)
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3500, tags: [],
    content: 'after the revocation #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b7', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  const to = rows.map(r => r.to)
  ok('a revoked key is not carried to', !to.includes(short(bumble)))
  // Control: the revocation removed exactly one recipient, not the lane.
  ok('CONTROL — a still-admitted key is carried to in the same pass', to.includes(short(mcclaude)))
  grantOf(bumble, 3)
}

// --- the managed-route CHANNEL binding still holds -----------------------------------------------
{
  // A managed route bound to a DIFFERENT channel: the broadcast bypasses the sender binding but
  // must not cross the room boundary.
  PUB.returnLane.push({ npub_hex: mcclaude, mention: 'mcclaude', authors: [], protocol: null,
    managedTaskRoute: true, scan_channel: 'other-room', scan_author: crew })
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3600, tags: [],
    content: 'room-scoped #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b8', author: oliver, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: oliver })
  const { rows } = await scanDelta([wire], { authors: PUB.scanAuthors, channel: INBOX })
  const to = rows.map(r => r.to)
  // mcclaude is now represented ONLY by the other-room managed route, so nothing should reach them.
  ok('a broadcast does not cross into a route bound to another channel', !to.includes(short(mcclaude)))
  ok('CONTROL — a recipient in THIS room still receives it', to.includes(short(bumble)))
  PUB.returnLane.pop()
}

// --- PRODUCTION SHAPE: the gate that strips the bridge's own signer -----------------------------
// Every check above passed while `sharedSigner` sat inside scan_authors, and that is not what the
// box looks like: PUB.scanAuthors deliberately STRIPS the bridge's Buzz poster key, and an admitted
// agent speaks through the relay lane, so the kind:9 in the channel is signed by exactly that
// stripped key. Observed live on 2026-08-10 — three days of
// `RETURN drop[author]: … signer 84753207… not in scan_authors`, dropping every agent-authored post
// before the marker was ever read. A fixture that puts the bridge signer in the gate cannot see it.
{
  const PROD_GATE = [crew]   // the bridge signer is NOT in here, exactly as on the box
  // A broadcaster who has not spent their per-minute cap in an earlier block. Using `oliver` here
  // failed on the rate limiter, not the gate — an accumulated-state coupling that would have read
  // as "the gate still drops it" and sent the next reader hunting in the wrong place.
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3700, tags: [],
    content: 'anyone out there? #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b9', author: bumble, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: bumble })
  const { rows } = await scanDelta([wire], { authors: PROD_GATE, channel: INBOX })
  ok('a granted agent\'s relay-lane broadcast crosses the signer gate that strips the bridge key',
    rows.length === 2 && rows.every(r => r.why === 'broadcast'))

  // NEGATIVE CONTROL, and the one that keeps the exception narrow: the SAME bridge-signed shape,
  // the same marker, but the registry resolves to a key holding no grant. A stranger's mirrored
  // note is exactly this: recorded with no agent at all, so it must not buy a fan-out.
  const stranger = getPublicKey(generateSecretKey())
  const wire2 = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 3800, tags: [],
    content: 'let me in #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-b10', author: stranger, buzz: wire2.id, dest: INBOX, q: false, ts: 0, agent: stranger })
  const second = await scanDelta([wire2], { authors: PROD_GATE, channel: INBOX })
  ok('an UNGRANTED agent-attributed post does not buy its way past the signer gate with the marker',
    second.rows.length === 0)
  ok('and it is refused at the signer gate by name', /drop\[author\]/.test(second.log))

}

// --- THE RELAXED GATE: agent-to-agent traffic generally, not only the marker --------------------
// The gate exclusion was written when echo was the only reason the bridge key could sign a channel
// post. The relay lane made that key sign FOR admitted agents. Echo is handled by the per-recipient
// registry check, not by this gate — so what follows must prove both halves: the traffic crosses,
// AND echo is still closed now that the gate is no longer doing that job by accident.
{
  const PROD_GATE = [crew]
  // FRESH identities, not oliver/mcclaude: those two have exchanged enough carries earlier in this
  // suite to trip the per-pair breaker, and a breaker trip reads exactly like a gate drop. That
  // coupling has now bitten this file twice — once on the rate cap, once here.
  const alfa = getPublicKey(generateSecretKey())
  const bravo = getPublicKey(generateSecretKey())
  grantOf(alfa, 7); grantOf(bravo, 8)

  // A plain p-tagged message from one agent to another, no marker anywhere.
  const wire = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 4200, tags: [['p', bravo]],
    content: 'alfa here, a direct word for one person and no marker' }, sharedSignerSk)))
  recordPosted({ id: 'orig-g1', author: alfa, buzz: wire.id, dest: INBOX, q: false, ts: 0, agent: alfa })
  const { rows } = await scanDelta([wire], { authors: PROD_GATE, channel: INBOX })
  ok('one agent can now reach another by p-tag, with no marker at all',
    rows.some(r => r.to === short(bravo) && r.why === 'mention'))

  // ECHO, now load-bearing: the gate used to stop this by accident, and no longer does.
  const echo = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 4300, tags: [['p', alfa]],
    content: 'alfa naming himself, which must never come back to him' }, sharedSignerSk)))
  recordPosted({ id: 'orig-g2', author: alfa, buzz: echo.id, dest: INBOX, q: false, ts: 0, agent: alfa })
  const back = await scanDelta([echo], { authors: PROD_GATE, channel: INBOX })
  ok('ECHO — an agent\'s own words never come back to them through the relaxed gate',
    !back.rows.some(r => r.to === short(alfa)))
  grantSet.delete(alfa); grantSet.delete(bravo)

  // NEGATIVE CONTROL — the bridge's OTHER posts. A quarantine header, a console confirmation or a
  // stranger's mirrored note is recorded with no agent at all, and must not ride the relaxation.
  const noAgent = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 4400, tags: [['p', mcclaude]],
    content: 'a bridge post attributed to nobody, naming mcclaude' }, sharedSignerSk)))
  recordPosted({ id: 'orig-g3', author: crew, buzz: noAgent.id, dest: INBOX, q: false, ts: 0, agent: null })
  const none = await scanDelta([noAgent], { authors: PROD_GATE, channel: INBOX })
  ok('NEGATIVE CONTROL — a bridge post with NO agent attribution is still gated out', none.rows.length === 0)
  ok('and it is refused by name at the signer gate', /drop\[author\]/.test(none.log))
}

// --- THE LOOP BREAKER ---------------------------------------------------------------------------
// The caps throttle; they do not terminate. Relay-lane posts are flat sends with no reply thread,
// so there is no depth to count — two auto-replying agents would otherwise run at the cap forever.
{
  const loopA = getPublicKey(generateSecretKey())
  const loopB = getPublicKey(generateSecretKey())
  grantOf(loopA, 5); grantOf(loopB, 6)
  // The open line fires ONCE, at the transition — so collect across the whole run. Reading only the
  // last iteration's log asserts the absence of a line that is deliberately not repeated.
  let carried = 0, allLogs = ''
  for (let i = 0; i < PAIR_MAX + 3; i++) {
    const w = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 5000 + i, tags: [['p', loopB]],
      content: `loop hop ${i}` }, sharedSignerSk)))
    recordPosted({ id: `orig-loop-${i}`, author: loopA, buzz: w.id, dest: INBOX, q: false, ts: 0, agent: loopA })
    const r = await scanDelta([w], { authors: [crew], channel: INBOX })
    if (r.rows.some(x => x.to === short(loopB))) carried++
    allLogs += r.log
  }
  ok(`the breaker stops the pair at ${PAIR_MAX}, not at ${PAIR_MAX + 3}`, carried === PAIR_MAX)
  ok('the breaker SAYS it opened, and names both ends',
    /RETURN breaker\[open\]/.test(allLogs) && allLogs.includes(loopA.slice(0, 12)) && allLogs.includes(loopB.slice(0, 12)))
  // CONTROL, the direction that matters most: a breaker keyed too widely would take out the whole
  // lane and read as "the bridge is down". The same sender, a different peer, must still get through.
  const w = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 5900, tags: [['p', mcclaude]],
    content: 'same sender, different peer' }, sharedSignerSk)))
  recordPosted({ id: 'orig-loop-other', author: loopA, buzz: w.id, dest: INBOX, q: false, ts: 0, agent: loopA })
  const r = await scanDelta([w], { authors: [crew], channel: INBOX })
  ok('CONTROL — the SAME sender still reaches a DIFFERENT peer; the breaker is per-pair, not per-sender',
    r.rows.some(x => x.to === short(mcclaude)))
  grantSet.delete(loopA); grantSet.delete(loopB)
}

// --- the rate cap, asserted rather than stumbled into --------------------------------------------
// It was found by a fixture failing on it, which means nothing pinned it. A fan-out primitive whose
// cap nobody asserts is a cap that can be removed without a single suite noticing.
{
  const nova = getPublicKey(generateSecretKey())
  grantOf(nova, 4)
  let lastLog = '', delivered = 0
  for (let i = 0; i < 7; i++) {
    const w = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 4000 + i, tags: [],
      content: `flood ${i} #wagglebroadcast` }, sharedSignerSk)))
    recordPosted({ id: `orig-flood-${i}`, author: nova, buzz: w.id, dest: INBOX, q: false, ts: 0, agent: nova })
    const r = await scanDelta([w], { authors: [crew], channel: INBOX })
    if (r.rows.length) delivered++
    lastLog = r.log
  }
  ok('a broadcaster is capped before all seven land', delivered < 7)
  ok('the cap SAYS what it dropped, and names the broadcaster', /BROADCAST drop\[rate\]/.test(lastLog))
  // CONTROL, in the other direction: the broadcast cap has its own counters and must not have
  // starved the lane it sits beside. A spent broadcaster can still be mentioned.
  const w = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 4100, tags: [['p', nova]],
    content: 'naming nova directly, no marker' }, crewSk)))
  const r = await scanDelta([w], { authors: [crew], channel: INBOX })
  ok('CONTROL — a direct mention still reaches a broadcaster who has spent their broadcast cap',
    r.rows.length === 1 && r.rows[0].why === 'mention')
  grantSet.delete(nova)
}

// --- ROOM SCOPE: a grant admits you to ONE channel ----------------------------------------------
// Finding 2 from review, and the one that broke the symmetry claim outright. A grant is verified
// against scopeHash(PUB.inbox, salt) — it admits you to the INBOX. Broadcasts fire while draining
// PUB.scanChannels, a separate config key, and nothing compared them: "you may address the room
// because you are in the room" actually read *you may address room Y because you are in room X*.
// This is only testable because inbox and the scanned channels are now distinct constants.
{
  const romeo = getPublicKey(generateSecretKey())
  const juliet = getPublicKey(generateSecretKey())
  grantOf(romeo, 9); grantOf(juliet, 10)

  const inField = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 6000, tags: [],
    content: 'broadcasting from a room my grant does not cover #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-room-1', author: romeo, buzz: inField.id, dest: FIELD, q: false, ts: 0, agent: romeo })
  const field = await scanDelta([inField], { authors: [crew], channel: FIELD })
  ok('a broadcast does NOT fan out in a watched channel that grants are not scoped to',
    !field.rows.some(r => r.to === short(juliet)))
  ok('and the refusal says it is the CHANNEL, not the grant', /not the channel admission grants are scoped to/.test(field.log))

  // CONTROL — the same sender, the same marker, in the room the grant actually covers. Without this
  // the check above cannot tell "refuses the wrong room" from "refuses everything".
  const inRoom = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 6001, tags: [],
    content: 'the same words, in the room my grant covers #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-room-2', author: romeo, buzz: inRoom.id, dest: INBOX, q: false, ts: 0, agent: romeo })
  const room = await scanDelta([inRoom], { authors: [crew], channel: INBOX })
  ok('CONTROL — the same broadcast DOES fan out in the granted room', room.rows.some(r => r.to === short(juliet)))
  grantSet.delete(romeo); grantSet.delete(juliet)
}

// --- TYPED ROUTES ARE SKIPPED, and the skip is visible ------------------------------------------
// Finding 3. nvoy origin/main mcp/tools/channel_task_carry.mjs:23 validates `reason` against a
// closed set and returns null — while still reporting the message AS a channel carry. So a
// broadcast would reach a task-route agent as a FAILED carry from an admitted peer, not an unknown
// one. Until that consumer bumps v, they do not receive broadcasts at all.
{
  const typed = getPublicKey(generateSecretKey())
  const plain = getPublicKey(generateSecretKey())
  grantOf(typed, 11); grantOf(plain, 12)
  PUB.returnLane.push({ npub_hex: typed, mention: 'typed', authors: [], protocol: 'nvoy-task-carry-v1', dynamic: false })

  const w = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 6100, tags: [],
    content: 'to the whole room #wagglebroadcast' }, sharedSignerSk)))
  recordPosted({ id: 'orig-typed-1', author: plain, buzz: w.id, dest: INBOX, q: false, ts: 0, agent: plain })
  const r = await scanDelta([w], { authors: [crew], channel: INBOX })
  ok('a typed task route receives NO broadcast', !r.rows.some(x => x.to === short(typed)))
  ok('and the skip is logged, naming the route and the reason', /skip\[typed-broadcast\]/.test(r.log))

  // CONTROL — the typed route is not simply broken. A direct mention still reaches it, as a
  // reason its consumer accepts.
  const w2 = JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 6101, tags: [['p', typed]],
    content: 'naming the typed route directly' }, sharedSignerSk)))
  recordPosted({ id: 'orig-typed-2', author: plain, buzz: w2.id, dest: INBOX, q: false, ts: 0, agent: plain })
  const r2 = await scanDelta([w2], { authors: [crew], channel: INBOX })
  ok('CONTROL — a MENTION still reaches the typed route', r2.rows.some(x => x.to === short(typed) && x.why === 'mention'))
  PUB.returnLane.pop(); grantSet.delete(typed); grantSet.delete(plain)
}

// --- the rendered body: what a recipient actually reads ------------------------------------------
{
  const body = buildBody('return_carry', { mention: 'guest', why: 'broadcast',
    body: 'is anyone else here?' })
  ok('the broadcast body names itself a broadcast', body.includes('**Broadcast**'))
  ok('it does not greet an admitted-only recipient as "guest"', !body.includes('**guest**'))
  ok('it says why it arrived', body.includes('#wagglebroadcast'))
  ok('it keeps the "replying here reaches nobody" instruction', body.includes('reaches nobody'))
  ok('the community body is quoted, never waggle\'s own voice', body.includes('\n> is anyone else here?'))

  // The existing prose must be untouched. egress_catalogue.mjs pins mention/reply byte-for-byte;
  // this is the same property asserted from the other side — a broadcast branch that leaked into
  // the mention branch would show up here as a broadcast word in a mention carry.
  const mention = buildBody('return_carry', { mention: 'claude', why: 'mention', body: 'x' })
  ok('CONTROL — the mention carry is unchanged by the broadcast branch',
    mention.startsWith('📥 **claude** — you were mentioned') && !mention.includes('Broadcast'))


  // WITHDRAWN UNDER REVIEW, asserted so it cannot come back by accident: the carry names no other
  // participant. The salted da-scope hides which room each public 440 is for, and a roster hands
  // that partition to anyone admitted anywhere.
  ok('NEGATIVE CONTROL — the broadcast body names no other participant', !/npub1/.test(body))

  // The typed contract, pinned from the catalogue side. `broadcast` was added to this enum once on
  // the reasoning that a new reason value is additive; nvoy's v:1 consumer hard-drops it. This
  // assertion is what stops it being re-added without a version bump — and it is the second line of
  // defence behind the loop skip, so removing the skip alone does not leak a broadcast into a typed
  // carry.
  let typedThrew = false
  try {
    buildBody('return_task_carry', { channel: INBOX, why: 'broadcast',
      source: JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, created_at: 7000, tags: [], content: 'x' }, crewSk))) })
  } catch { typedThrew = true }
  ok('NEGATIVE CONTROL — the typed task carry refuses reason=broadcast until its consumer bumps v', typedThrew)

}

process.stderr.write = realErr
console.log(fails
  ? `\nRETURN LANE BROADCAST FAIL — ${fails}`
  : '\nRETURN LANE BROADCAST PASS — marker, grant gate both ways, room scope, precedence, typed-route skip, breaker, dedup')
process.exit(fails ? 1 : 0)
