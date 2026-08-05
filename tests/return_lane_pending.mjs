// tests/return_lane_pending.mjs — the send-side no-miss past the overlap (#117).
//
// #116 made a 0/N loud and rolled back the dedup so the overlap re-read retries it. But the scan
// cursor advances whether or not a carry landed, so that retry only happens while the message
// stays inside the overlap window. An outage sustained past it aged the carry out and lost it —
// loud for a while, then silent, which is the shape this lane exists to prevent.
//
// The fix is a durable pending queue retried INDEPENDENT of the cursor. The property under test
// is therefore not "a retry happens" but "a retry happens after nothing is looking at the message
// any more" — so every retry case below runs with no `msgs` at all, exactly as a later poll would.
//
// Holding the cursor was the rejected alternative: one permanently-unreachable recipient would pin
// it forever and stall the lane for everyone. Hence the bound and the dead letter, asserted here.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wb-rlp-'))

const AGENT = 'a'.repeat(64)
const HUMAN = 'b'.repeat(64)
const CH = '11111111-1111-1111-1111-111111111111'

writeFileSync(join(dir, 'config.json'), JSON.stringify({
  relays: [], recipients: [],
  public: {
    relays: [], inbox: CH, staging_inbox: CH,
    watch_authors: [], watch_events: [], approvers: [], grantors: [],
    scan_authors: [], scan_channels: [CH], relay_channels: [],
    return_lane: [{ name: 'Claude', mention: 'claude', npub_hex: AGENT }],
  },
}))

process.env.CONFIG_PATH = join(dir, 'config.json')
process.env.FORWARD_MODE = 'dryrun'
process.env.SEALED_LANES = 'off'
process.env.SEEN_PATH = join(dir, 'seen.log')
process.env.RLSEEN_PATH = join(dir, 'rlseen.log')
process.env.RLPENDING_PATH = join(dir, 'rlpending.log')
process.env.RLPENDING_MAX_ATTEMPTS = '3'
// scanReturnLane and the retry driver both refuse without a bridge key.
process.env.BUZZ_PRIVATE_KEY = 'c'.repeat(64)

const B = await import('../src/bridge.mjs')

let fails = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) fails++
}

// A publish seam: `accepted` is the relay accept-count returnLaneSend reports.
let accept = 0
const publish = async () => accept
const msg = (id) => ({ id, pubkey: HUMAN, content: 'hey @claude look at this', tags: [] })

try {
  // --- a 0/N carry becomes OWED -------------------------------------------------------------
  accept = 0
  await B.scanReturnLane([msg('e'.repeat(64))], { publish })
  ok('a 0/N carry is recorded as still-owed', B.rlPending.size() === 1)
  ok('...and is NOT marked as carried', !B.rlSeen.has(B.rlKey('e'.repeat(64), AGENT)))
  ok('...and it persisted to disk, so a restart still owes it', existsSync(join(dir, 'rlpending.log')) &&
    readFileSync(join(dir, 'rlpending.log'), 'utf8').includes('e'.repeat(64)))

  // --- the retry runs with NO messages: the cursor has moved on ------------------------------
  // This is the whole point. Nothing is re-reading this message; the only thing that knows it is
  // owed is the queue.
  accept = 1
  await B.retryPendingCarries({ publish })
  ok('a later poll retries the owed carry with no message in hand', B.rlPending.size() === 0)
  ok('...and once it lands it is marked carried', B.rlSeen.has(B.rlKey('e'.repeat(64), AGENT)))

  // --- a landed carry never enters the queue (NEGATIVE CONTROL) ------------------------------
  // Every check above passes just as well if enqueue were unconditional, so prove the success
  // path stays out of the queue entirely.
  accept = 1
  await B.scanReturnLane([msg('f'.repeat(64))], { publish })
  ok('NEGATIVE CONTROL — a carry that lands first time is never queued', B.rlPending.size() === 0)
  ok('NEGATIVE CONTROL — ...and is marked carried', B.rlSeen.has(B.rlKey('f'.repeat(64), AGENT)))

  // --- bounded: a permanently-dead recipient is dead-lettered, not retried forever -----------
  accept = 0
  await B.scanReturnLane([msg('d'.repeat(64))], { publish })
  ok('an unreachable recipient is owed', B.rlPending.size() === 1)

  const attemptsSeen = []
  for (let i = 0; i < 5; i++) {
    attemptsSeen.push(B.rlPending.entries()[0]?.attempts ?? null)
    await B.retryPendingCarries({ publish })
  }
  ok('attempts are counted across polls, not reset', attemptsSeen[1] === 1 && attemptsSeen[2] === 2)
  ok(`bounded at RLPENDING_MAX_ATTEMPTS (${process.env.RLPENDING_MAX_ATTEMPTS}) — the queue drains`,
    B.rlPending.size() === 0, `still owed: ${B.rlPending.size()}`)
  ok('a dead-lettered carry is NOT marked as carried — it was lost, and the record says so',
    !B.rlSeen.has(B.rlKey('d'.repeat(64), AGENT)))

  // --- durability: the queue survives a restart ----------------------------------------------
  accept = 0
  await B.scanReturnLane([msg('9'.repeat(64))], { publish })
  ok('a fresh 0/N is owed again', B.rlPending.size() === 1)
  const reloaded = (await import('../src/stores.mjs')).durableQueue({
    path: join(dir, 'rlpending.log'), cap: 5000, label: 'reload',
  })
  reloaded.load()
  ok('a restart reloads exactly what is still owed, and nothing already settled',
    reloaded.size() === 1 && reloaded.entries()[0].key.startsWith('9'.repeat(64)),
    `reloaded ${reloaded.size()}: ${reloaded.entries().map(e => e.key.slice(0, 8)).join(',')}`)

  // A queue entry is not "durable" merely because it reached memory. Force appendFileSync to
  // fail against a directory and prove enqueue rolls the hot claim back and reports failure.
  const unwritablePath = join(dir, 'queue-is-a-directory')
  mkdirSync(unwritablePath)
  const failing = (await import('../src/stores.mjs')).durableQueue({ path: unwritablePath, cap: 10, label: 'forced-failure' })
  ok('a failed durable enqueue returns false and leaves no memory-only phantom debt',
    failing.enqueue('owed', { source: 'x' }) === false && failing.size() === 0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\nreturn_lane_pending: ${fails} FAILED` : '\nreturn_lane_pending: all checks passed')
process.exit(fails ? 1 : 0)
