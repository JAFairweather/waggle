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
process.env.SEND_JOURNAL_PATH = join(dir, 'send-journal.log')
process.env.BUZZ_PRIVATE_KEY = 'c'.repeat(64)   // returnLaneSend refuses to seal with no bridge key
delete process.env.WB_STUB_SEND          // the stub short-circuits the publisher entirely

const { refusalKey, refusalLedger, explainSendRefusals, defuseJournalText, REFUSAL_TEXT_MAX } = await import('../src/relay_refusals.mjs')
const { publishWrapToRelayList, relayRefusals, returnLaneSend, PUB } = await import('../src/bridge.mjs')

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

// #374 review: an accept must END the refusal episode. Otherwise "this relay started refusing
// again after a week" is folded into "this relay is still refusing" — two different events for an
// operator, and only the first is actionable. Its own ledger, so it cannot perturb the counts the
// sequence above depends on.
{
  const lines = []
  const L = refusalLedger({ log: (m) => lines.push(m) })
  const R = 'wss://nos.lol'

  ok('episode: the first refusal is logged',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (12)' }) === 'logged' && lines.length === 1)
  ok('  …and a repeat inside the episode is suppressed',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (9)' }) === 'suppressed' && lines.length === 1)
  ok('  …an ACCEPT ends the episode',
    L.record({ relay: R, accepted: true, reason: '' }) === 'accepted')
  ok('  …so the SAME reason afterwards is logged again, not swallowed as still-refusing',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (12)' }) === 'logged' && lines.length === 2)
  // Both directions: without this, "resets on accept" is indistinguishable from never suppressing.
  ok('  …and suppression still holds WITHIN the new episode — this is not "log everything"',
    L.record({ relay: R, accepted: false, reason: 'pow: 28 bits needed. (11)' }) === 'suppressed' && lines.length === 2)
}

// ── #402: a short ratio is explained by THIS send, never by the ledger's lifetime view ────────
// The ledger view (`summary()`) is right for a periodic report and wrong for "why was this send
// short": a relay that refused on a different send, to a different relay set, is unrelated history.
// The negative control matters more than the positive one — a fix that explains nothing passes the
// positive half too, so both must hold: this send's own reason is named, and history's is not.
{
  ok('a relay with no refusals in this send explains to null — nothing to blame, so nothing is said',
    explainSendRefusals([]) === null && explainSendRefusals(null) === null)
  ok('one refusal is named with its reason',
    explainSendRefusals([{ relay: 'wss://a.invalid', reason: 'pow: 28 bits needed. (12)' }]) ===
    'wss://a.invalid: pow: 28 bits needed. (12)')
  ok('  …a second relay from the SAME send is named alongside it, first reason kept if repeated',
    explainSendRefusals([
      { relay: 'wss://a.invalid', reason: 'pow: 28 bits needed. (12)' },
      { relay: 'wss://b.invalid', reason: 'blocked: not on the allow list' },
      { relay: 'wss://a.invalid', reason: 'pow: 28 bits needed. (9)' },
    ]) === 'wss://a.invalid: pow: 28 bits needed. (12) · wss://b.invalid: blocked: not on the allow list')
}
{
  // THE PAIRED HALF, end to end through the real publisher. `relayRefusals` (the shared ledger) is
  // seeded with an UNRELATED relay's refusal from a prior send, standing in for "nos.lol refused
  // hours ago". A fresh send then goes to two DIFFERENT relays, neither of them the seeded one.
  const made = []
  const mkSocket = (url) => {
    const h = {}
    const s = {
      url, on(ev, fn) { (h[ev] ||= []).push(fn); return this }, send() {}, close() {},
      emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a) },
      frame(o) { this.emit('message', { toString: () => JSON.stringify(o) }) },
    }
    made.push(s)
    return s
  }

  relayRefusals.reset()
  relayRefusals.record({ relay: 'wss://stale-history.invalid', accepted: false, reason: 'pow: 28 bits needed. (12)' })

  const wrap = { id: 'e'.repeat(64), kind: 1059, content: 'x', tags: [], pubkey: 'b'.repeat(64), created_at: 1, sig: 'c'.repeat(128) }
  const RELAYS = ['wss://this-send-a.invalid', 'wss://this-send-b.invalid']
  const collected = []
  const p = publishWrapToRelayList(wrap, RELAYS, mkSocket, (r) => collected.push(r))
  made[0].emit('open'); made[1].emit('open')
  made[0].frame(['OK', wrap.id, false, 'blocked: not on the allow list'])
  made[1].frame(['OK', wrap.id, true, ''])
  const accepted = await p
  ok('the send is short (1 of 2), same as before onRefusal existed', accepted === 1)

  const explanation = explainSendRefusals(collected)
  ok('POSITIVE — the relay that refused THIS send is named, with its own reason',
    /this-send-a\.invalid: blocked: not on the allow list/.test(explanation))
  ok('NEGATIVE (load-bearing) — the relay that never saw this send is NOT named, even though the ' +
    'shared ledger still remembers it refusing earlier — a fix that explains nothing would pass the ' +
    'POSITIVE assertion above by accident, so this is the one that catches it',
    !/stale-history\.invalid/.test(String(explanation)))
  ok('  …and the accepting relay from this send is not named as a refusal either',
    !/this-send-b\.invalid/.test(String(explanation)))
}
{
  // A timeout in this send has no reason (matches the ledger's own rule above) — onRefusal must not
  // invent one, so a short ratio caused purely by silence explains to null, not to stale history.
  const made = []
  const mkSocket = (url) => {
    const h = {}
    const s = { url, on(ev, fn) { (h[ev] ||= []).push(fn); return this }, send() {}, close() {}, emit(ev, ...a) { for (const fn of h[ev] || []) fn(...a) } }
    made.push(s); return s
  }
  relayRefusals.reset()
  relayRefusals.record({ relay: 'wss://stale-history.invalid', accepted: false, reason: 'pow: 28 bits needed. (12)' })
  const wrap = { id: 'f'.repeat(64), kind: 1059, content: 'x', tags: [], pubkey: 'b'.repeat(64), created_at: 1, sig: 'c'.repeat(128) }
  const collected = []
  const accepted = await publishWrapToRelayList(wrap, ['wss://silent-this-send.invalid'], mkSocket, (r) => collected.push(r))
  ok('a relay that never answers contributes no accept', accepted === 0)
  ok('  …onRefusal was never called — a timeout is not a refusal, in this send or any other',
    collected.length === 0 && explainSendRefusals(collected) === null)
}

// ── #402 gap: `returnLaneSend` itself, not the two functions it calls in isolation ────────────
// Every assertion above drives `explainSendRefusals` or `publishWrapToRelayList` directly. The
// line that actually shipped the bug lives one level up — the RETURN log statement INSIDE
// `returnLaneSend` — and nothing above calls that function at all, so reverting only that one
// line back to `relayRefusals.summary()` would leave every prior assertion green. This drives the
// real function with an injected publish, reads the real console line it wrote, and checks it the
// same both-directions way: named when it should be, silent about unrelated history when it
// should be.
{
  const savedRelays = PUB.relays
  PUB.relays = ['wss://this-send-a.invalid', 'wss://this-send-b.invalid']

  relayRefusals.reset()
  // Stands in for "a different relay refused a different send, hours ago" — still live in the
  // shared ledger at the moment THIS send runs.
  relayRefusals.record({ relay: 'wss://stale-history.invalid', accepted: false, reason: 'pow: 28 bits needed. (12)' })

  const testPublish = async (_wrap, _mkSocket, onRefusal) => {
    if (typeof onRefusal === 'function') onRefusal({ relay: 'wss://this-send-a.invalid', reason: 'blocked: not on the allow list' })
    return 1   // 1 of the 2 configured relays — a short ratio, so the RETURN line explains itself
  }

  const said = []
  const realLog = console.log, realErr = console.error
  console.log = (...a) => { said.push(a.join(' ')) }
  console.error = (...a) => { said.push(a.join(' ')) }
  let accepted
  try {
    accepted = await returnLaneSend(
      'a'.repeat(64),
      { template: 'return_carry', slots: { mention: 'someone', why: 'mention', body: 'hello there', author: null } },
      {},
      testPublish,
    )
  } finally {
    console.log = realLog; console.error = realErr
    PUB.relays = savedRelays
  }

  ok('returnLaneSend reports the short accept count unchanged', accepted === 1)
  const line = said.find(l => l.includes('RETURN'))
  ok('returnLaneSend logged a RETURN line at all — a test that captured nothing has proven nothing',
    !!line)
  ok('POSITIVE — the RETURN line names THIS send\'s own refusing relay, with its own reason',
    !!line && /this-send-a\.invalid: blocked: not on the allow list/.test(line))
  ok('NEGATIVE (load-bearing) — it does NOT fall back to the shared ledger\'s unrelated history, ' +
    'live in that ledger at the moment this send ran; reverting the RETURN line inside ' +
    'returnLaneSend back to relayRefusals.summary() makes this assertion fail',
    !!line && !/stale-history\.invalid/.test(line))
}

// -- bounded and defused, and still readable (#405) --------------------------------------------
// #374's whole point is that the relay's own words reach an operator. Nothing bounded or
// sanitised them. The journal is read by a human AND by the tripwire, so a relay can put a line
// break plus a plausible `RELAY[buzz] ok ->` into a reason and write a sentence in the bridge's
// mouth; or send a megabyte; or send an escape sequence. On the return lane the relay set comes
// from the recipient's own kind:10050, so whoever chooses the relay chooses the text.
//
// BOTH DIRECTIONS, and the positive one is load-bearing: a guard that mangles
// `pow: 28 bits needed. (12)` hides the exact fault #374 exists to reveal. Every invisible
// character below is written \uXXXX and never as itself -- a fixture nobody can read is a
// fixture nobody can check, and a heredoc has silently eaten one of these before.
{
  const REAL = 'pow: 28 bits needed. (12)'
  ok('an ordinary refusal survives byte for byte -- the guard is invisible on the happy path',
    defuseJournalText(REAL) === REAL)
  ok('so does a long-but-plausible one, unchanged and untruncated',
    defuseJournalText('blocked: pubkey not on the allow list for this relay') ===
      'blocked: pubkey not on the allow list for this relay')

  // Shaped like a real forged journal line, not 'x'.repeat(n).
  const FORGERY = 'rejected: bad sig\u000A2026-08-13T01:00:00Z RELAY[buzz] ok -> a8186b53: from ad05b00e'
  const forged = defuseJournalText(FORGERY)
  ok('a newline cannot synthesise a second journal line',
    !/[\u000A\u000D]/.test(forged))
  ok('  ...and the text is still THERE, flattened rather than censored -- what the relay tried is ' +
    'the actionable part, so a guard that deleted it would cost the operator the finding',
    forged.includes('rejected: bad sig') && forged.includes('RELAY[buzz] ok'))

  const ESCAPED = defuseJournalText('rate\u001B[2Jlimited')
  ok('an ESC is removed so a refusal cannot rewrite the operator terminal',
    !ESCAPED.includes('\u001B'))
  ok('  ...and what is left is inert but legible, not a hole in the line',
    ESCAPED === 'rate [2Jlimited')

  ok('NUL, DEL and C1 go the same way as CR and LF -- the whole range, not the ones abused so far',
    defuseJournalText('a\u0000b\u007Fc\u0085d') === 'a b c d')

  const HUGE = defuseJournalText('x'.repeat(50000))
  ok('a megabyte reason does not become a megabyte journal line',
    HUGE.length < REFUSAL_TEXT_MAX + 40)
  ok('  ...and the line SAYS it truncated and by how much -- assert the reason, not merely that ' +
    'something was trimmed, because 50000 characters is itself the news',
    /\(truncated, 50000 chars\)$/.test(HUGE))

  ok('a reason of nothing but line breaks empties out, so the caller reports (no reason given)',
    defuseJournalText('\u000D\u000A\u000A') === '')
  ok('null and undefined do not throw and do not print the word null',
    defuseJournalText(null) === '' && defuseJournalText(undefined) === '')

  // -- through the ledger and the fanout explainer, not only the helper --------------------
  const lines = []
  const led = refusalLedger({ log: (m) => lines.push(m) })
  led.record({ relay: 'wss://relay.invalid', accepted: false, reason: FORGERY })
  ok('the ledger logged at all -- a capture with nothing in it has proven nothing',
    lines.length === 1)
  ok('the ledger line carries no line break either',
    lines.length === 1 && !/[\u000A\u000D]/.test(lines[0]))
  ok('  ...and it still names the relay and the reason',
    lines.length === 1 && /relay\.invalid/.test(lines[0]) && /rejected: bad sig/.test(lines[0]))

  // The relay URL is chosen by the same party as the reason, so defusing one fixes half of it.
  const led2 = refusalLedger({ log: (m) => lines.push(m) })
  led2.record({ relay: 'wss://evil.invalid\u000A2026-08-13T01:00:00Z FORGED', accepted: false, reason: 'no' })
  ok('a relay URL cannot forge a line either',
    lines.length === 2 && !/[\u000A\u000D]/.test(lines[1]))
  ok('summary() defuses the relay it prints, not just the reason',
    !/[\u000A\u000D]/.test(String(led2.summary() || '')))

  // Suppression is keyed on the RAW reason and must not have moved.
  const led3 = refusalLedger({ log: () => {} })
  ok('defusing did not change what counts as the same refusal -- bracketed detail still folds, ' +
    'and a genuinely different reason still speaks',
    led3.record({ relay: 'r', accepted: false, reason: 'pow: 28 bits needed. (12)' }) === 'logged' &&
    led3.record({ relay: 'r', accepted: false, reason: 'pow: 28 bits needed. (9)' }) === 'suppressed' &&
    led3.record({ relay: 'r', accepted: false, reason: 'pow: 32 bits needed. (9)' }) === 'logged')

  const exp = explainSendRefusals([{ relay: 'wss://a.invalid', reason: FORGERY }])
  ok('explainSendRefusals follows the SAME rule rather than a second one',
    !/[\u000A\u000D]/.test(exp) && exp.includes('rejected: bad sig'))
  ok('  ...and an ordinary reason still comes through it untouched',
    explainSendRefusals([{ relay: 'wss://a.invalid', reason: REAL }]) === 'wss://a.invalid: ' + REAL)
}

console.info(`\n${fails ? `RELAY REFUSAL FAIL — ${fails}` : 'RELAY REFUSAL PASS — the reason survives, the repeat is quiet, a change speaks, and nothing forges a line'}`)
process.exit(fails ? 1 : 0)
