// fanout — the shared relay fan-out primitive (#153).
//
// Three call sites hand-rolled this before: fetchProfileName, fetchEventById and
// publishWrapToRelays. They diverged, and the divergence was a bug — one closed its sockets in
// finish(), another only on EOSE/error, so a relay that opened and never answered leaked its socket
// FOREVER, precisely when the timeout won the race. That is the case the timeout exists for, and
// nothing asserted it, which is why it survived until it was read by eye.
//
// So the load-bearing check here is: WHEN THE TIMEOUT WINS, EVERY SOCKET IS CLOSED.
//
// No network. `mkSocket` is injected, so the settle rules are drivable directly — the first time
// these paths have been testable at all.
//
// Run: node tests/relay_fanout.mjs   (exit 0 = pass, 1 = fail)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wb-fanout-'))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.SEEN_PATH = join(dir, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(dir, 'watermark')

const { fanout } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.info(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// A socket that records what was done to it and never answers unless told to.
function fakeSocket(url) {
  const handlers = {}
  return {
    url,
    closed: false,
    sent: [],
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return this },
    close() { this.closed = true },
    emit(ev, ...a) { for (const fn of handlers[ev] || []) fn(...a) },
    frame(obj) { this.emit('message', { toString: () => JSON.stringify(obj) }) },
  }
}
const makeFactory = (made) => (url) => { const s = fakeSocket(url); made.push(s); return s }
const RELAYS = ['wss://a.invalid', 'wss://b.invalid', 'wss://c.invalid']

// --- THE bug: a relay that opens and never answers must not leak its socket ------------------
{
  const made = []
  const started = Date.now()
  const result = await fanout(RELAYS, {
    timeoutMs: 50,
    mkSocket: makeFactory(made),
    each: () => { /* deliberately silent: nobody ever calls done() */ },
    collect: () => 'timed-out',
  })
  ok('a silent fan-out still settles, on the timeout', result === 'timed-out')
  ok('  it waited for the budget rather than returning instantly', Date.now() - started >= 45)
  ok('  EVERY socket is closed when the timeout wins (the #153 bug)',
    made.length === 3 && made.every(s => s.closed))
}

// --- first-match settles early, and closes the losers ----------------------------------------
{
  const made = []
  const p = fanout(RELAYS, {
    timeoutMs: 5000,
    mkSocket: makeFactory(made),
    each: (ws, done, settleNow) => {
      ws.on('message', (d) => { if (JSON.parse(d.toString())[0] === 'HIT') settleNow() })
      ws.on('error', done)
    },
    collect: () => 'first-match',
  })
  made[1].frame(['HIT'])
  ok('first-match settles as soon as one relay answers', await p === 'first-match')
  ok('  the relays that did not answer are closed too', made.every(s => s.closed))
}

// --- all-settled counts only what actually landed ---------------------------------------------
{
  const made = []
  let accepted = 0
  const p = fanout(RELAYS, {
    timeoutMs: 5000,
    mkSocket: makeFactory(made),
    each: (ws, done) => {
      ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m[0] === 'OK') { if (m[2]) accepted++; done() } })
      ws.on('error', done)
    },
    collect: () => accepted,
  })
  made[0].frame(['OK', 'id', true])    // accepted
  made[1].frame(['OK', 'id', false])   // an explicit REJECTION is not an accept
  made[2].emit('error', new Error('dead relay'))
  ok('all-settled resolves once every relay has answered', await p === 1)
  ok('  an explicit OK-false is not counted as an accept', accepted === 1)
}

// --- a socket that cannot even be constructed must not hang the fan-out -----------------------
{
  const made = []
  let n = 0
  const p = fanout(RELAYS, {
    timeoutMs: 5000,
    mkSocket: (url) => { if (++n === 2) throw new Error('bad url'); const s = fakeSocket(url); made.push(s); return s },
    each: (ws, done) => ws.on('error', done),
    collect: () => 'settled',
  })
  for (const s of made) s.emit('error', new Error('x'))
  ok('a socket that throws on construction is counted, not waited on', await p === 'settled')
}

// --- an empty relay set resolves immediately, and does not arm a timer -------------------------
{
  const started = Date.now()
  const r = await fanout([], { timeoutMs: 10000, mkSocket: () => { throw new Error('never') }, each: () => {}, collect: () => 'empty' })
  ok('an empty relay set settles immediately', r === 'empty' && Date.now() - started < 1000)
}

// --- settle happens exactly once ---------------------------------------------------------------
{
  const made = []
  let collected = 0
  const p = fanout(RELAYS, {
    timeoutMs: 5000,
    mkSocket: makeFactory(made),
    each: (ws, done, settleNow) => { ws.on('message', () => settleNow()); ws.on('error', done) },
    collect: () => ++collected,
  })
  made[0].frame(['x']); made[1].frame(['x']); made[2].frame(['x'])   // three racing settles
  await p
  ok('collect() runs exactly once even when several relays settle at once', collected === 1)
}

console.info(fails ? `\nrelay_fanout: ${fails} check(s) failed` : '\nrelay_fanout: all checks passed')
process.exit(fails ? 1 : 0)
