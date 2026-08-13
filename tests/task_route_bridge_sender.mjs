// task_route_bridge_sender.mjs — a task route cannot seat the bridge's own key in the signer gate.
//
// `PUB.scanAuthors` is the return-lane signer gate, and it has TWO writers. The roster path strips
// BRIDGE_PK — from an explicit `scan_authors` list and from the declared-trust floor alike, under a
// comment that states flatly that the bridge's own key is never admitted. The other writer is
// `installTaskRoutes`, which unions every route's `sender` into the same set, and it stripped
// nothing. So a route could put back the one key the gate is documented never to hold (#340).
//
// The damage is not a wider roster. The bridge signs EVERY carried post — every outside agent's
// mirrored note, every repost, every quarantine header — so admitting its key lets waggle's own
// repost of one agent's note pass the signer gate and be re-routed by mention. That is the echo the
// design excludes, arriving through the config field least likely to be read as a gate.
//
// SCOPE, measured rather than assumed. Managed task routes apply a SECOND, per-route signer check
// (`r.scan_author !== from`), so a bridge-signed message reaches a managed route only if that
// route's own sender is the bridge key. A LEGACY `return_lane` row has no such check — the global
// gate is its only signer test, so every legacy recipient is exposed by one bad route elsewhere in
// the file. Section 3 demonstrates that leg; the first draft of it aimed at a managed route,
// asserted a carry the second guard was quietly preventing, and FAILED. Left in, it would have
// shipped a test proving the wrong thing.
//
// Not remotely reachable: both writers need owner input — `public.task_routes` at boot, or an
// approver-signed console upsert. It is a footgun in a documented invariant, not an open door. Both
// are closed here because both run through `normalizedTaskRoute`.
//
// The load-bearing part of this file is section 3. Sections 1 and 2 prove the gate no longer holds
// the key; only section 3 proves that holding it is what would have carried the message, by running
// the same message against the pre-fix gate and watching it cross.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey, finalizeEvent, getEventHash } from 'nostr-tools/pure'

let pass = true
const ok = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}${cond || !detail ? '' : `  [${detail}]`}`)
  if (!cond) pass = false
}

const dir = mkdtempSync(resolve(tmpdir(), 'wb-route-sender-'))
const bridgeSk = generateSecretKey()
const bridgePk = getPublicKey(bridgeSk)
const crewSk = generateSecretKey(), crew = getPublicKey(crewSk)
const mcClaude = getPublicKey(generateSecretKey())
const oliver = getPublicKey(generateSecretKey())
const legacy = getPublicKey(generateSecretKey())
const channel = 'a8186b53-537d-46ad-a7e7-b6486c58970e'

// Two routes, identical but for the sender. The good one is the control that keeps this test from
// passing by refusing everything — the failure mode that took a real recipient off the air here
// once already.
writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
  relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
  watch_authors: [], watch_events: [], approvers: [crew], grantors: [],
  // The explicit roster also names the bridge key. That path was already filtered; it is here so a
  // regression in EITHER writer is visible from one boot.
  scan_authors: [bridgePk, crew], scan_channels: [],
  // A legacy, manually-declared recipient. It matters because managed task routes carry a SECOND,
  // per-route signer check (`r.scan_author !== from`) that a legacy row does not — so for this row
  // the global gate is the only thing standing between a bridge-signed message and delivery. Found
  // by a negative control that failed: the first draft asserted a carry that a different guard was
  // quietly preventing, which would have shipped a test proving the wrong thing.
  return_lane: [{ npub_hex: legacy, mention: 'Legacy' }],
  task_routes: [
    { participant: mcClaude, sender: crew, channel, mention: 'MC Claude', protocol: 'nvoy-task-carry-v1' },
    { participant: oliver, sender: bridgePk, channel, mention: 'Oliver', protocol: 'nvoy-task-carry-v1' },
  ],
} }))
process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'rlseen.log')
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { scanReturnLane, handleSealedTaskRouteControl, PUB, grantSet } = await import('../src/bridge.mjs')
grantSet.set(mcClaude, { grantId: '1'.repeat(64), grantor: crew })
grantSet.set(oliver, { grantId: '2'.repeat(64), grantor: crew })

// ── 1. The route is refused, and the legitimate one beside it is not ─────────────────────────
console.log('\n1. the route')

ok('a route whose sender is the bridge key is refused at parse', PUB.taskRoutes.length === 1,
  `${PUB.taskRoutes.length} routes survived`)
ok('BOTH DIRECTIONS — the identical route with a real sender survives, so this is not a parser that refuses everything',
  PUB.taskRoutes[0]?.mention === 'MC Claude', PUB.taskRoutes.map(r => r.mention).join('|'))
ok('and the refused route leaves no return-lane row behind',
  !PUB.returnLane.some(r => r.npub_hex === oliver))

// ── 2. Neither writer of the signer gate holds the bridge key ────────────────────────────────
console.log('\n2. the gate')

ok('the explicit roster path still strips it', !PUB.manualScanAuthors.includes(bridgePk))
ok('and the task-route path no longer puts it back — this is the fix (#340)',
  !PUB.scanAuthors.includes(bridgePk), PUB.scanAuthors.map(k => k.slice(0, 12)).join(' '))
ok('while the gate is not merely empty — the crew key is still seated',
  PUB.scanAuthors.includes(crew), PUB.scanAuthors.length ? '' : 'gate is EMPTY')

// ── 3. What the key in the gate would actually have done ─────────────────────────────────────
//
// Sections 1 and 2 are assertions about a list. This one runs a message. Same message, same
// scanner, two gates: the one the bridge now builds, and the one it built before the fix. If the
// message is refused by both, the gate is not what stops it and sections 1–2 prove nothing.
console.log('\n3. the consequence, with the control that makes it mean something')

const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
let seq = 0
async function carriedBy(body, signer, authors) {
  const before = journal().filter(r => r.lane === 'return').length
  const wire = JSON.parse(JSON.stringify(finalizeEvent(
    { kind: 9, created_at: 1000 + (seq++), tags: [['h', channel]], content: body }, signer)))
  await scanReturnLane([wire], { authors, channel })
  return journal().filter(r => r.lane === 'return').slice(before).map(r => r.to)
}
const short = k => k.slice(0, 12)

// waggle re-posting an agent's words is exactly what a mirrored note looks like on the wire:
// signed by the bridge, carrying the mention the original author wrote.
const REPOST = '@Legacy — please take a look at this.'

const throughFixed = await carriedBy(REPOST, bridgeSk, PUB.scanAuthors)
ok('a bridge-signed repost does NOT cross the gate the bridge now builds',
  throughFixed.length === 0, throughFixed.join('|'))

// NEGATIVE CONTROL — the pre-fix gate, reconstructed by hand: the identical set plus the one key
// the route used to add. Not "a gate that rejects" — the same gate, one key different.
//
// This assertion earned its place by failing. The first draft aimed the repost at a managed task
// route and it did not cross, because managed routes apply their own `scan_author` check on top of
// the global gate. That is a real second guard and it narrows the finding: the global gate is the
// ONLY signer check for a legacy recipient, so that is the row the seated key exposes.
const preFix = [...PUB.scanAuthors, bridgePk]
const throughBroken = await carriedBy(REPOST, bridgeSk, preFix)
ok('NEGATIVE CONTROL — through the pre-fix gate the SAME repost crosses to a legacy recipient',
  throughBroken.length === 1 && throughBroken[0] === short(legacy), throughBroken.join('|') || 'nothing crossed')

// BOTH DIRECTIONS at the level that matters: the gate the bridge now builds still carries the
// traffic it exists to carry. A gate that stopped the echo by stopping everything is the outage
// this project has already had once.
const fromCrew = await carriedBy('@MC Claude and @Legacy — a real message from a real person.', crewSk, PUB.scanAuthors)
ok('BOTH DIRECTIONS — a crew message still reaches its agents through the same gate',
  fromCrew.length === 2 && fromCrew.slice().sort().join('|') === [short(mcClaude), short(legacy)].sort().join('|'),
  fromCrew.join('|') || 'nothing crossed')

// ── 4. The reason, not only the refusal ──────────────────────────────────────────────────────
//
// `!ok` cannot tell a correct refusal from a correct refusal with a misleading explanation, and the
// generic fallback here reads "invalid participant, sender, channel or protocol" — four fields, one
// of them wrong, which is how an owner spends an afternoon on the participant key.
console.log('\n4. the reason')

// Driven through the real sealed command, not asserted against the source. An earlier draft
// counted `taskRouteSenderProblem(` occurrences and required three; deleting the call from the
// console path left exactly three (definition, parser, boot) and the mutation survived. A scan of
// the mechanism cannot see which call site was removed — only running the path can.
const wire = ev => JSON.parse(JSON.stringify(ev))
const upsert = async (sender, mention, created_at) => {
  const body = { v: 1, type: 'waggle-task-route', action: 'upsert', channel,
    participant: mcClaude, sender, mention, protocol: 'nvoy-task-carry-v1' }
  const draft = { kind: 14, pubkey: crew, created_at, content: JSON.stringify(body), tags: [['p', bridgePk]] }
  const rumor = { ...draft, id: getEventHash(draft) }
  const seal = wire(finalizeEvent({ kind: 13, created_at, content: 'encrypted', tags: [] }, crewSk))
  const wrap = wire(finalizeEvent({ kind: 1059, created_at, content: 'opaque', tags: [['p', bridgePk]] }, generateSecretKey()))
  return handleSealedTaskRouteControl(wrap, { openSealFn: async () => seal, openRumorFn: async () => rumor })
}

const now = Math.floor(Date.now() / 1000)
const refusedUpsert = await upsert(bridgePk, 'Impostor', now)
ok('an approver-signed console upsert with the bridge key as sender is refused', refusedUpsert.ok === false,
  JSON.stringify(refusedUpsert))
ok("and the reason NAMES the sender rather than the four-field fallback — `!ok` cannot tell a correct refusal from a misleading one",
  /sender is the bridge's own key/.test(String(refusedUpsert.reason || '')), String(refusedUpsert.reason))
ok('and the refusal did not seat the bridge key in the gate on its way out',
  !PUB.scanAuthors.includes(bridgePk), PUB.scanAuthors.map(k => k.slice(0, 12)).join(' '))

const acceptedUpsert = await upsert(crew, 'MC Claude', now + 1)
ok('BOTH DIRECTIONS — the same command with a real sender is accepted, so the console path is not simply closed',
  acceptedUpsert.ok === true, JSON.stringify(acceptedUpsert))

// ── 5. The boot path says so out loud ────────────────────────────────────────────────────────
//
// A route dropped in silence is #340's actual complaint restated: nothing failed, nothing was
// logged where anyone looked, and the reply simply never came. The boot refusal writes to stderr,
// which the in-process assertions above cannot see — so run a second boot in a child and read it.
// A mutation that removed the named reason from THIS path survived every other section.
console.log('\n5. the boot refusal, read from a child process')

const bootStderr = (routes) => {
  const d = mkdtempSync(resolve(tmpdir(), 'wb-route-boot-'))
  writeFileSync(resolve(d, 'config.json'), JSON.stringify({ relays: [], recipients: [], public: {
    relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [crew], scan_channels: [], task_routes: routes,
  } }))
  const env = { ...process.env, CONFIG_PATH: resolve(d, 'config.json'),
    SEND_JOURNAL_PATH: resolve(d, 'j.log'), SEEN_PATH: resolve(d, 's.log'),
    POSTED_MAP_PATH: resolve(d, 'p.log'), RLSEEN_PATH: resolve(d, 'r.log') }
  const out = spawnSync(process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../src/bridge.mjs', import.meta.url).href)})`],
    { env, encoding: 'utf8', timeout: 60000 })
  return `${out.stderr || ''}`
}

const goodRoute = { participant: mcClaude, sender: crew, channel, mention: 'MC Claude', protocol: 'nvoy-task-carry-v1' }
const noisy = bootStderr([goodRoute, { ...goodRoute, sender: bridgePk, mention: 'Impostor' }])
if (noisy.length < 20) { console.error(`task_route_bridge_sender: INCONCLUSIVE — the child produced ${noisy.length}B of stderr; a scan of nothing reports clean`); process.exit(3) }
ok('a route refused at boot is NAMED on stderr, with its index and its reason',
  /task_routes\[1\] ignored/.test(noisy) && /sender is the bridge's own key/.test(noisy),
  noisy.split('\n').filter(l => /task route/.test(l)).join(' | ') || '(no task-route line at all)')

// NEGATIVE CONTROL — the same boot without the bad route must not print the refusal. An alarm that
// always fires and one that never fires fail identically.
const quiet = bootStderr([goodRoute])
ok('NEGATIVE CONTROL — a boot with only legitimate routes says nothing about a bad sender',
  !/ignored/.test(quiet) && !/bridge's own key/.test(quiet),
  quiet.split('\n').filter(l => /task route/.test(l)).join(' | '))

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
