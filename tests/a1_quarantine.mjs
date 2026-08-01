// A1 quarantine-gate demonstration / regression test.
//
// Proves the read-lane reply gate (bridge.mjs routePublic): an un-allowlisted external
// reply to one of our notes is QUARANTINED into the staging channel and never reaches a
// community channel, while an allowlisted watched author is trusted straight to the inbox,
// and an unrelated stranger note is dropped entirely.
//
// Also proves the gate that guards all three: a note whose SIGNATURE does not hold is dropped
// before any of that classification runs. `ev.pubkey` is only a claim until the signature backs
// it, and the trust tiers are keyed on exactly that field — so an unverified note wearing a
// watched author's key would take the MOST trusted path in the file. The relays are not trusted
// parties; one hostile relay is enough to serve such a note.
//
// Side-effect-free: FORWARD_MODE=dryrun (no network send, no markSeen, no watermark bump)
// and SEEN_PATH / PUB_WATERMARK_PATH redirected to a throwaway temp dir, so it touches no
// production dedup state. Drives the REAL exported routePublic — not a copy.
//
// Run: node tests/a1_quarantine.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const tmp = mkdtempSync(join(tmpdir(), 'wb-a1-'))
process.env.WB_NO_BOOT = '1'            // import without opening any relay socket
process.env.FORWARD_MODE = 'dryrun'     // log routing decision, send nothing, mutate nothing
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')

const { routePublic, PUB } = await import('../src/bridge.mjs')

// Ground the test in the live config so a config drift (e.g. staging removed) fails it.
const COMMUNITY = PUB.inbox                 // real community channel
const STAGING = PUB.staging                 // real quarantine channel
const WATCHED_NOTE = PUB.events[0]          // one of our own published notes

if (!STAGING) { console.error('FAIL: no staging channel configured — A1 default-closes to HOLD, cannot demo quarantine'); process.exit(1) }
if (!PUB.authors.length || !WATCHED_NOTE) { console.error('FAIL: config missing watch_authors/watch_events'); process.exit(1) }

// The AUTHORS, unlike the channels, are generated rather than read from config: routePublic now
// demands a valid signature, and only a key we hold can produce one. So the test mints its own
// watched author and admits it to the mirrored-feed tier for the duration of the run. The config
// grounding above still fails on drift; what moves here is only who signs.
const watchedSk = generateSecretKey()
const WATCHED_AUTHOR = getPublicKey(watchedSk)
const strangerSk = generateSecretKey()
const STRANGER = getPublicKey(strangerSk)
PUB.authors.push(WATCHED_AUTHOR)

// Capture everything the module logs while routing.
let buf = ''
const cap = (...a) => { buf += a.join(' ') + '\n' }
console.log = cap
console.error = cap

const note = (sk, over) => finalizeEvent({
  kind: 1, tags: [], content: 'hi', created_at: Math.floor(Date.now() / 1000), ...over,
}, sk)

// Case A — allowlisted watched author posts. Trusted → community inbox, NOT quarantined.
const a = note(watchedSk, { content: 'watched-author note' })
routePublic(a)
// Case B — UNKNOWN key replies (#e) to one of our notes. Untrusted → STAGING.
const b = note(strangerSk, { tags: [['e', WATCHED_NOTE]], content: 'stranger reply' })
routePublic(b)
// Case C — unknown key, no #e to a watched note, not a watched author. Dropped (no route).
const c = note(strangerSk, { tags: [['e', 'd'.repeat(64)]], content: 'unrelated stranger' })
routePublic(c)
// Case D — FORGERY. A note genuinely signed by the stranger, then re-labelled with the watched
// author's key. JSON round-trip because that is how a relay delivers it — and because nostr-tools
// memoises a verification result on the object itself, so a spread copy would carry the original's
// verdict and the forgery would appear to verify. On the wire there is no such shortcut.
const d = JSON.parse(JSON.stringify({ ...note(strangerSk, { content: 'forged: I never wrote this' }), pubkey: WATCHED_AUTHOR }))
routePublic(d)

const out = buf
const line = (sub) => out.split('\n').filter(l => l.includes(sub))
const idlog = (ev) => ev.id.slice(0, 12) // how the bridge prints a note's id (truncated)

let pass = true
const check = (cond, label) => { console.info(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// Case A: routed to the community inbox, labelled inbox (not STAGING).
check(line(idlog(a)).some(l => l.includes(`-> inbox ${COMMUNITY}`)),
  `allowlisted watched author -> community inbox (${COMMUNITY.slice(0, 8)})`)
// Case B: routed to STAGING, and specifically the id-2 event went there.
check(line(idlog(b)).some(l => l.includes(`-> STAGING ${STAGING}`)),
  `unknown-key reply -> STAGING (${STAGING.slice(0, 8)})`)
// Case B, the load-bearing negative: the stranger reply NEVER hit the community inbox.
check(!line(idlog(b)).some(l => l.includes(`-> inbox ${COMMUNITY}`)),
  `unknown-key reply NEVER reaches community inbox`)
// Case C: unrelated stranger note produced no PUBLIC routing line at all.
check(!line(idlog(c)).some(l => l.includes('PUBLIC')),
  `unrelated stranger note -> dropped (no route)`)
// Case D: the forgery is refused, by name, and lands NOWHERE.
check(line(idlog(d)).some(l => l.includes('drop[bad-signature]')),
  `forged note wearing a watched author's key -> dropped, and said so`)
check(!line(idlog(d)).some(l => l.includes(`-> inbox ${COMMUNITY}`) || l.includes(`-> STAGING ${STAGING}`)),
  `forged note reaches NEITHER the community inbox NOR staging`)

console.info(pass ? '\nA1 PASS — quarantine gate holds' : '\nA1 FAIL')
process.exit(pass ? 0 : 1)
