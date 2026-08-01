// undelivered.mjs — a send that FAILS must leave a durable record (#171).
//
// Why this test exists: both Buzz lanes commit the event id to durable dedup BEFORE the async
// send — deliberately, because the project favours "never double-post" (the §8 firehose line)
// over "never drop". That trade is a real position and this suite does not argue with it. What it
// asserts is the part that was missing: when the losing side of the trade happens, the loss is
// WRITTEN DOWN. Before #171 a failed send produced one ERR line in a rotating journal, and the
// message was gone with nothing to count, audit, or replay.
//
// It also closes a gap the whole suite had: NO test drove a failing transport. Every one either
// set WB_STUB_SEND or replaced the transport with something that resolves — which is precisely why
// a slot escaper that threw inside a delivery path stayed green through 19 suites while production
// dropped messages.
//
// Drives the real recordUndelivered plus the real egress transport seam. No sockets, temp dir only.

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wb-undelivered-'))
process.env.UNDELIVERED_PATH = join(dir, 'undelivered.log')
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'

let fails = 0
const ok = (name, cond, detail = '') => {
  if (cond) return console.log(`  ok   ${name}`)
  fails++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('undelivered record (#171)')

try {
  const { recordUndelivered } = await import('../src/bridge.mjs')
  const { emit, __setTransportForTests } = await import('../src/egress.mjs')

  const readLog = () => existsSync(process.env.UNDELIVERED_PATH)
    ? readFileSync(process.env.UNDELIVERED_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : []

  // --- the record itself ------------------------------------------------------------------
  ok('no file exists before anything fails', readLog().length === 0)

  recordUndelivered({
    lane: 'sealed', dest: 'inbox-uuid', recipient: 'My Dude',
    id: 'a'.repeat(64), author: 'b'.repeat(64), reason: 'egress: slot rejected (handle)',
  })

  const rows = readLog()
  ok('a failed delivery is written down', rows.length === 1)
  ok('it is machine-readable, not prose', rows[0] && typeof rows[0] === 'object')
  ok('it names the recipient who did not get it', rows[0]?.recipient === 'My Dude',
    'the whole point: a plane fan-out delivers to the others and silently not to this one')
  ok('it names the lane', rows[0]?.lane === 'sealed')
  ok('it keeps the event id, so the message is recoverable from a relay', rows[0]?.id === 'a'.repeat(64))
  ok('it keeps the author', rows[0]?.author === 'b'.repeat(64))
  ok('it keeps why it failed', /slot rejected/.test(rows[0]?.reason || ''))
  ok('it is timestamped', Number.isFinite(rows[0]?.ts) && rows[0].ts > 0)

  // Append-only: a second loss must not overwrite the first.
  recordUndelivered({ lane: 'public', dest: 'staging', id: 'c'.repeat(64), reason: 'boom' })
  const two = readLog()
  ok('append-only — a second loss does not erase the first', two.length === 2 && two[0].id === 'a'.repeat(64))
  ok('a recipient-less lane records null rather than omitting the field', two[1].recipient === null)

  // A long reason is truncated, so one pathological error cannot flood the file the way an
  // untruncated stack trace would.
  recordUndelivered({ lane: 'public', dest: 'x', id: 'd'.repeat(64), reason: 'z'.repeat(5000) })
  ok('a huge reason is capped', readLog()[2].reason.length <= 300)

  // --- recording must never become the new failure ------------------------------------------
  let threw = false
  try {
    recordUndelivered({ lane: 'sealed', dest: '/', id: 'e'.repeat(64), reason: 'x' })
  } catch { threw = true }
  ok('recording never throws into the delivery path', !threw,
    'a failure to record a failure must not take down the lane')

  // --- the gap this suite closes: a transport that actually FAILS ---------------------------
  //
  // Every other suite stubs success. This one makes emit() reject and asserts the caller sees a
  // real rejection it can record — the shape no existing test exercised.
  const restore = __setTransportForTests(() => Promise.reject(new Error('relay refused: simulated')))
  let caught = null
  try {
    await emit({ template: 'a7_tombstone', dest: 'chan', slots: { author: 'f'.repeat(64), origId: 'a'.repeat(64), delId: 'b'.repeat(64) } })
  } catch (e) { caught = e }
  restore()
  ok('a failing transport rejects rather than resolving quietly', caught !== null)
  ok('the rejection carries the reason the recorder needs', /relay refused/.test(caught?.message || ''))

  // NEGATIVE CONTROL. Everything above passes if recordUndelivered wrote unconditionally, and it
  // passes if the transport always rejected. Assert the other direction of each: a SUCCEEDING
  // transport resolves and adds no row.
  const before = readLog().length
  const restore2 = __setTransportForTests(() => Promise.resolve('{"event_id":"' + 'a'.repeat(64) + '"}'))
  let resolved = false
  try {
    await emit({ template: 'a7_tombstone', dest: 'chan', slots: { author: 'f'.repeat(64), origId: 'a'.repeat(64), delId: 'b'.repeat(64) } })
    resolved = true
  } catch { resolved = false }
  restore2()
  ok('NEGATIVE CONTROL — a working transport still resolves', resolved,
    'if this fails the seam is broken and every "it failed" assertion above is meaningless')
  ok('NEGATIVE CONTROL — a successful send records no loss', readLog().length === before)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\nundelivered: ${fails} check(s) failed` : '\nall checks passed')
process.exit(fails ? 1 : 0)
