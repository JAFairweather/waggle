// relay_refusal.mjs — what a relay said when it refused (#374).
//
// `publishWrapToRelayList` read `["OK", <id>, <bool>]` and dropped `m[3]`. nos.lol has refused every
// sealed wrap since 2026-08-08 with `pow: 28 bits needed. (12)`, and that string appeared nowhere in
// the journal: the lane reported a lower count and a slow relay looked identical to a refusing one.
//
// Three things here are asserted in BOTH directions, because each has a failure that passes an
// ordinary one-sided test:
//
//   1. **What counts as a refusal.** `["OK", id, true, "duplicate: have this event"]` carries a
//      message and is an ACCEPT — the healthiest answer a relay gives. A ledger that keys off "there
//      is a message" would report the working relays as the broken ones. So: a refusal is recorded
//      AND an accept-with-a-message records nothing.
//   2. **Suppression.** Logging every refusal floods a box the tripwire reads; logging once and
//      never again goes quiet at the exact moment the reason changes. So: a repeat is silent AND a
//      changed reason speaks.
//   3. **What "the same reason" means.** `pow: 28 bits needed. (12)` and `(9)` and `(17)` are ONE
//      refusal — the bracketed number is this event's own difficulty and changes every send. Compare
//      raw and suppression never engages, so the anti-flood fix IS the flood. So: the bracketed part
//      is ignored AND a change to the part outside the brackets is not.
//
// The last block drives the REAL publisher through a fake socket rather than the ledger alone —
// a ledger that works while nothing calls it is the defect this replaces.
//
//   node tests/relay_refusal.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wb-refusal-'))
process.env.WB_NO_BOOT = '1'
process.env.FORWARD_MODE = 'dryrun'
process.env.SEEN_PATH = join(dir, 'seen.log')
process.env.PUB_WATERMARK_PATH = join(dir, 'watermark')
delete process.env.WB_STUB_SEND          // the stub short-circuits the publisher entirely

const { refusalKey, refusalLedger } = await import('../src/relay_refusals.mjs')
const { publishWrapToRelayList, relayRefusals } = await import('../src/bridge.mjs')

let fails = 0
const ok = (n, c) => { console.info(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// ── what "the same reason" means ─────────────────────────────────────────────────────────────
{
  const LIVE = 'pow: 28 bits needed. (12)'      // the exact string nos.lol returns
  ok('the live nos.lol refusal and the same refusal with a different achieved difficulty are ONE reason',
    refusalKey(LIVE) === refusalKey('pow: 28 bits needed. (9)') &&
    refusalKey(LIVE) === refusalKey('pow: 28 bits needed. (17)'))
  ok('  …and the TARGET changing is a different reason — 28 bits and 32 bits are news, (12) never is',
    refusalKey(LIVE) !== refusalKey('pow: 32 bits needed. (12)'))
  ok('  …and a completely different refusal is different',
    refusalKey(LIVE) !== refusalKey('blocked: not on the allow list'))
  ok('  case and trailing punctuation do not make a second reason',
    refusalKey('POW: 28 Bits Needed.') === refusalKey('pow: 28 bits needed'))
  ok('  an empty reason keys to something stable rather than throwing',
    refusalKey('') === '' && refusalKey(null) === '' && refusalKey(undefined) === '')
}

// ── the ledger: refusal vs accept, and suppression both ways ─────────────────────────────────
{
  const lines = []
  const L = refusalLedger({ log: (m) => lines.push(m) })
  const R = 'wss://nos.lol'

  ok('a refusal is LOGGED the first time',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (12)' }) === 'logged' &&
    lines.length === 1 && /pow: 28 bits needed/.test(lines[0]) && lines[0].includes(R))
  ok('an identical refusal is counted, not logged again',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (9)' }) === 'suppressed' &&
    lines.length === 1)
  ok('  …twenty more of them are still one line',
    Array.from({ length: 20 }, (_, i) => L.record({ relay: R, accepted: false, reason: `pow: 28 bits needed. (${i})` }))
      .every(v => v === 'suppressed') && lines.length === 1)
  ok('a CHANGED reason from the same relay speaks up — suppression that never lifts is not logging',
    L.record({ relay: R, accepted: false, reason: 'blocked: not on the allow list' }) === 'logged' &&
    lines.length === 2 && /CHANGED/.test(lines[1]))
  ok('  …and the new line carries the OLD reason too, or nobody can tell what changed',
    /pow: 28 bits needed/.test(lines[1]) && /blocked: not on the allow list/.test(lines[1]))

  // THE PAIRED HALF. Everything above is satisfied by a ledger that treats every frame as a
  // refusal — which would report every healthy relay as broken, forever.
  const before = lines.length
  ok('an ACCEPT records nothing and logs nothing, even carrying a message',
    L.record({ relay: 'wss://good.invalid', accepted: true, reason: 'duplicate: have this event' }) === 'accepted' &&
    lines.length === before)
  ok('  …and that relay does not appear in the summary at all',
    !String(L.summary()).includes('good.invalid'))
  ok('  …while the refusing one does, with its count and its reason',
    /nos\.lol: refused 23 of 23 — blocked: not on the allow list/.test(L.summary()))
}
{
  const L = refusalLedger({ log: () => {} })
  ok('a ledger nothing has refused to summarises to null — a summary printed every tick is one nobody reads',
    L.summary() === null)
  L.record({ relay: 'wss://a.invalid', accepted: true })
  ok('  …and an all-accepts ledger is still null, not an empty string that reads as a fault',
    L.summary() === null)
}
{
  // Bounded. Keyed on the relay, so an inventive relay cannot grow it — but the cap is the backstop.
  const L = refusalLedger({ cap: 3, log: () => {} })
  for (let i = 0; i < 10; i++) L.record({ relay: `wss://r${i}.invalid`, accepted: false, reason: 'no' })
  ok('the ledger is bounded by its cap', L.size() === 3)
  ok('  …and it evicted the OLDEST, so the newest relay — the one nobody has seen behave yet — is visible',
    L.rows().some(r => r.relay === 'wss://r9.invalid') && !L.rows().some(r => r.relay === 'wss://r0.invalid'))
  const snap = L.rows()
  snap[0].refused = 9999
  ok('  rows() hands back copies — a caller cannot edit the ledger by reading it',
    L.rows()[0].refused !== 9999)
}

// ── through the REAL publisher, with a fake socket ───────────────────────────────────────────
{
  const made = []
  const mkSocket = (url) => {
    const h = {}
    const s = {
      url, closed: false, sent: [],
      on(ev, fn) { (h[ev] ||= []).push(fn); return this },
      send(payload) { this.sent.push(payload) },
      close() { this.closed = true },
      emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a) },
      frame(o) { this.emit('message', { toString: () => JSON.stringify(o) }) },
    }
    made.push(s)
    return s
  }
  const wrap = { id: 'a'.repeat(64), kind: 1059, content: 'x', tags: [], pubkey: 'b'.repeat(64), created_at: 1, sig: 'c'.repeat(128) }
  const RELAYS = ['wss://refuser.invalid', 'wss://accepter.invalid']

  relayRefusals.reset()
  const p = publishWrapToRelayList(wrap, RELAYS, mkSocket)
  made[0].emit('open'); made[1].emit('open')
  made[0].frame(['OK', wrap.id, false, 'pow: 28 bits needed. (12)'])
  made[1].frame(['OK', wrap.id, true, ''])
  const accepted = await p

  ok('the publisher still returns a plain accept count — every caller does arithmetic on it',
    accepted === 1)
  const rows = relayRefusals.rows()
  const refuser = rows.find(r => r.relay === 'wss://refuser.invalid')
  const accepter = rows.find(r => r.relay === 'wss://accepter.invalid')
  ok('the refusing relay is named — which was impossible before, since `each` never saw the URL',
    !!refuser && refuser.refused === 1)
  ok('  …WITH the reason the relay actually gave, which is the whole point of #374',
    refuser.reason === 'pow: 28 bits needed. (12)')
  ok('  …and the accepting relay is recorded as an accept, not as a refusal with an empty reason',
    !!accepter && accepter.accepted === 1 && accepter.refused === 0)
  ok('  …so the summary names one relay, not both',
    /refuser\.invalid/.test(relayRefusals.summary()) && !/accepter\.invalid/.test(relayRefusals.summary()))
}
{
  // A relay that opens and says nothing is NOT a refusal. "No answer" and "no" are different facts
  // and only one of them has a reason; conflating them would attribute a timeout to a rule.
  const made = []
  const mkSocket = (url) => {
    const h = {}
    const s = { url, on(ev, fn) { (h[ev] ||= []).push(fn); return this }, send() {}, close() {}, emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a) } }
    made.push(s); return s
  }
  const wrap = { id: 'd'.repeat(64), kind: 1059, content: 'x', tags: [], pubkey: 'b'.repeat(64), created_at: 1, sig: 'c'.repeat(128) }
  relayRefusals.reset()
  const accepted = await publishWrapToRelayList(wrap, ['wss://silent.invalid'], mkSocket)
  ok('a relay that never answers contributes no accept', accepted === 0)
  ok('  …and is NOT recorded as a refusal — a timeout has no reason, and inventing one is worse than silence',
    relayRefusals.summary() === null && relayRefusals.rows().length === 0)
}

console.info(`\n${fails ? `RELAY REFUSAL FAIL — ${fails}` : 'RELAY REFUSAL PASS — the reason survives, the repeat is quiet, and a change speaks'}`)
process.exit(fails ? 1 : 0)
