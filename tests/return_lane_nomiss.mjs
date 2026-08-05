// Return-lane NO-MISS ACROSS DOWNTIME (#5) — the arming gate.
//
// return_lane_scan.mjs proves the gate/fan-out/echo shape on a set of messages HANDED to
// scanReturnLane. It never exercises how that set is GATHERED. The hazard #5 names lives entirely
// in the gathering: pollScanChannels used to read the 30 newest scan-channel messages with no
// since-watermark, so an outage long enough to bury a mention past the newest page dropped it
// silently — and durable rlSeen can never recover a message that was never scanned (it closes the
// re-SEND half, not the MISS half). This proves the fix, driving the real scanChannel() through its
// injected page-fetch seam so the window + pagination are exercised without a relay socket:
//
//   • NEGATIVE CONTROL — a single newest-page read (the old blind `--limit`) MISSES a mention
//     buried past the page. The hazard is real, reproduced through the same seam.
//   • NO-MISS — scanChannel paginates with --before back to the cursor floor and carries the
//     buried mention anyway.
//   • ATOMic DRAIN — a page read that fails mid-walk carries NOTHING and leaves the cursor
//     unmoved, so the next poll re-reads (a failed read is never a silent skip past the backlog).
//   • CURSOR — first boot floors to the bounded lookback (no cursor yet); a clean drain advances
//     the persisted cursor to the newest created_at seen.
//   • OVERLAP is a no-op — the cursor-minus-overlap re-read re-scans an already-carried mention,
//     and durable rlSeen suppresses the re-carry (overlap buys no-miss, never a double-send).
//
//   node tests/return_lane_nomiss.mjs

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPublicKey, generateSecretKey, finalizeEvent } from 'nostr-tools/pure'

const dir = mkdtempSync(resolve(tmpdir(), 'wb-nomiss-'))
const bridgeSk = generateSecretKey()
const claude = getPublicKey(generateSecretKey())
const crewSk = generateSecretKey()
const crew = getPublicKey(crewSk)

writeFileSync(resolve(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: ['wss://example.invalid'], inbox: 'chan', staging_inbox: 'chan',
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [crew],
    scan_channels: ['scanchan'],
    return_lane: [{ npub_hex: claude, mention: 'claude', authors: [] }],
  },
}, null, 2))

process.env.CONFIG_PATH = resolve(dir, 'config.json')
process.env.SEND_JOURNAL_PATH = resolve(dir, 'send-journal.log')
process.env.SEEN_PATH = resolve(dir, 'seen.log')
process.env.POSTED_MAP_PATH = resolve(dir, 'posted.log')
process.env.RLSEEN_PATH = resolve(dir, 'return-lane-seen.log')
process.env.SCAN_WATERMARK_PATH = resolve(dir, 'scan-watermark.json')
process.env.SCAN_PAGE_LIMIT = '3'          // tiny page so a 7-message backlog forces pagination
process.env.SCAN_WATERMARK_OVERLAP = '5'   // overlap in seconds; re-reads must be no-ops
process.env.SCAN_BOOTSTRAP_SECS = '172800' // 48h first-boot floor, matches the DM lane
process.env.BUZZ_PRIVATE_KEY = Buffer.from(bridgeSk).toString('hex')
process.env.FORWARD_MODE = 'buzz'
process.env.WB_STUB_SEND = '1'
process.env.WB_NO_BOOT = '1'

const { scanChannel, scanSince, loadScanCursors } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }
const journal = () => existsSync(process.env.SEND_JOURNAL_PATH)
  ? readFileSync(process.env.SEND_JOURNAL_PATH, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
const carries = () => journal().filter(row => row.lane === 'return')
const short = k => k.slice(0, 12)

// --- synthetic backlog: 7 crew messages inside the 48h window, newest-first ids m1..m7 -----------
// The OLDEST (buried) and one RECENT message both mention @claude; the rest are non-mention noise.
const now = Math.floor(Date.now() / 1000)
const store = []
for (let i = 7; i >= 1; i--) {                 // created_at now-7 (oldest) .. now-1 (newest)
  let content = `just chatter ${i}`
  if (i === 7) content = 'heads up @claude — buried under the backlog'
  if (i === 2) content = '@claude one more recent thing'
  store.push(JSON.parse(JSON.stringify(finalizeEvent({ kind: 9, content, created_at: now - i, tags: [] }, crewSk))))
}
const BURIED = store.find(m => m.content.includes('buried under the backlog')).id

// A relay-shaped page fetch honouring `--since floor`, `--before`, `--limit 3`, newest-first.
// `failOn` makes the Nth call error, to model a mid-drain read failure.
function makeFetch(failOn = 0) {
  let calls = 0
  return (ch, floor, before, cb) => {
    calls++
    if (failOn && calls === failOn) return cb(new Error('synthetic read failure'))
    let rows = store.filter(m => m.created_at >= floor)
    if (before) rows = rows.filter(m => m.created_at < before)
    rows = rows.sort((a, b) => b.created_at - a.created_at).slice(0, 3)
    cb(null, rows)
  }
}

// --- first boot: bounded lookback, no cursor yet -------------------------------------------------
ok('first boot has NO persisted cursor', loadScanCursors().scanchan === undefined)
ok('first-boot floor is the 48h lookback, not "newest only"',
  Math.abs(scanSince('scanchan') - (now - 172800)) <= 2)

// --- NEGATIVE CONTROL: the old blind newest-page read MISSES the buried mention -------------------
let firstPage
makeFetch()('scanchan', now - 172800, null, (_e, rows) => { firstPage = rows })
ok('the newest page does not even contain the buried mention (hazard reproduced)',
  !firstPage.some(m => m.id === BURIED))

// --- ATOMIC DRAIN: a read that fails mid-walk carries nothing and never advances the cursor -------
// Page 1 succeeds (3 msgs, none a mention), page 2 errors → acc is dropped, cursor untouched.
let before = carries().length
await scanChannel('failchan', makeFetch(2))
ok('a mid-drain read failure carries NOTHING', carries().length === before)
ok('a failed drain never advances the cursor (next poll re-reads)', loadScanCursors().failchan === undefined)

// --- NO-MISS: a clean paginated drain carries the buried mention despite the page limit -----------
before = carries().length
await scanChannel('scanchan', makeFetch())
let carried = carries().slice(before)
const toBuried = carried.filter(e => e.to === short(claude))
ok('the buried mention is delivered (no-miss across the backlog)',
  toBuried.length === 2)                        // buried m7 + recent m2, both @claude, one carry each
ok('the buried and recent mentions BOTH carried, nothing else did', carried.length === 2)

// --- CURSOR: a clean drain advances the persisted cursor to the newest created_at seen ------------
ok('the cursor advanced to the newest message', loadScanCursors().scanchan === now - 1)
ok('the next poll now reads from cursor-minus-overlap, not the 48h floor',
  scanSince('scanchan') === (now - 1) - 5)

// --- OVERLAP is a no-op: the re-read re-scans an already-carried mention, rlSeen suppresses it -----
// scanSince is now (now-1)-5 = now-6, so the re-read window includes the RECENT mention (now-2).
before = carries().length
await scanChannel('scanchan', makeFetch())
ok('the overlap re-read carries nothing new (durable rlSeen suppresses the re-send)',
  carries().length === before)
ok('the recent mention was inside the overlap window (the re-read really did re-scan it)',
  scanSince('scanchan') <= (now - 2))

console.log(fails
  ? `\nRETURN LANE NO-MISS FAIL — ${fails}`
  : '\nRETURN LANE NO-MISS PASS — hazard reproduced, paginated no-miss, atomic drain, cursor + overlap')
process.exit(fails ? 1 : 0)
