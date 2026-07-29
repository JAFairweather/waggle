// A1 quarantine-gate demonstration / regression test.
//
// Proves the read-lane reply gate (bridge.mjs routePublic): an un-allowlisted external
// reply to one of our notes is QUARANTINED into the staging channel and never reaches a
// community channel, while an allowlisted watched author is trusted straight to the inbox,
// and an unrelated stranger note is dropped entirely.
//
// Side-effect-free: FORWARD_MODE=dryrun (no network send, no markSeen, no watermark bump)
// and SEEN_PATH / PUB_WATERMARK_PATH redirected to a throwaway temp dir, so it touches no
// production dedup state. Drives the REAL exported routePublic — not a copy.
//
// Run: node tests/a1_quarantine.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'wb-a1-'))
process.env.WB_NO_BOOT = '1'            // import without opening any relay socket
process.env.FORWARD_MODE = 'dryrun'     // log routing decision, send nothing, mutate nothing
process.env.SEEN_PATH = join(tmp, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(tmp, 'watermark')

const { routePublic, PUB } = await import('../src/bridge.mjs')

// Ground the test in the live config so a config drift (e.g. staging removed) fails it.
const COMMUNITY = PUB.inbox                 // real community channel
const STAGING = PUB.staging                 // real quarantine channel
const WATCHED_AUTHOR = PUB.authors[0]       // allowlisted (trusted)
const WATCHED_NOTE = PUB.events[0]          // one of our own published notes
const STRANGER = 'f'.repeat(64)             // a key on nobody's allowlist

if (!STAGING) { console.error('FAIL: no staging channel configured — A1 default-closes to HOLD, cannot demo quarantine'); process.exit(1) }
if (!WATCHED_AUTHOR || !WATCHED_NOTE) { console.error('FAIL: config missing watch_authors/watch_events'); process.exit(1) }

// Capture everything the module logs while routing.
let buf = ''
const cap = (c => (...a) => { buf += a.join(' ') + '\n' })()
console.log = cap
console.error = cap

// Pad on the RIGHT: the bridge logs a note's id truncated to its first 12 chars, so the
// distinguishing digit must live at the FRONT or every synthetic id collapses to one string.
const hexId = n => String(n).padEnd(64, '0')
const note = (over) => ({ id: hexId(over.n), kind: 1, pubkey: STRANGER, tags: [], content: 'hi', created_at: Math.floor(Date.now() / 1000), ...over })

// Case A — allowlisted watched author posts. Trusted → community inbox, NOT quarantined.
routePublic(note({ n: 1, pubkey: WATCHED_AUTHOR, content: 'watched-author note' }))
// Case B — UNKNOWN key replies (#e) to one of our notes. Untrusted → STAGING.
routePublic(note({ n: 2, pubkey: STRANGER, tags: [['e', WATCHED_NOTE]], content: 'stranger reply' }))
// Case C — unknown key, no #e to a watched note, not a watched author. Dropped (no route).
routePublic(note({ n: 3, pubkey: STRANGER, tags: [['e', hexId(999)]], content: 'unrelated stranger' }))

const out = buf
const restore = () => { /* process exits right after; no need to restore */ }
restore()

const line = (sub) => out.split('\n').filter(l => l.includes(sub))
const has = (sub) => out.includes(sub)
const idlog = (n) => hexId(n).slice(0, 12) // how the bridge prints a note's id (truncated)

let pass = true
const check = (cond, label) => { console.info(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// Case A: routed to the community inbox, labelled inbox (not STAGING).
check(line(idlog(1)).some(l => l.includes(`-> inbox ${COMMUNITY}`)),
  `allowlisted watched author -> community inbox (${COMMUNITY.slice(0, 8)})`)
// Case B: routed to STAGING, and specifically the id-2 event went there.
check(line(idlog(2)).some(l => l.includes(`-> STAGING ${STAGING}`)),
  `unknown-key reply -> STAGING (${STAGING.slice(0, 8)})`)
// Case B, the load-bearing negative: the stranger reply NEVER hit the community inbox.
check(!line(idlog(2)).some(l => l.includes(`-> inbox ${COMMUNITY}`)),
  `unknown-key reply NEVER reaches community inbox`)
// Case C: unrelated stranger note produced no PUBLIC routing line at all.
check(!line(idlog(3)).some(l => l.includes('PUBLIC')),
  `unrelated stranger note -> dropped (no route)`)

console.info(pass ? '\nA1 PASS — quarantine gate holds' : '\nA1 FAIL')
process.exit(pass ? 0 : 1)
