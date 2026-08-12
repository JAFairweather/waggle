// pow.mjs — NIP-13 difficulty, and the three ways a miner lies (#346).
//
// A miner is unusually easy to write wrong in ways that pass an obvious test, because the obvious
// test is "did it produce a nonce tag" and every one of these produces a nonce tag:
//
//   1. **Counting nibbles instead of bits.** `000f…` is 12 leading zero bits, not 16, and not 3
//      hex zeroes' worth of anything. A nibble-counter over-reports by up to three bits on every
//      id, so it commits to a target the event does not meet — worse than no proof-of-work, since
//      a relay may ban on a false claim.
//   2. **Committing to what was reached rather than what was asked.** Mining to 8 and landing on
//      11 is fine; writing `11` into the tag is a claim the NEXT event will not repeat.
//   3. **Refusing everything, or refusing nothing.** The cap is the only thing standing between a
//      1-vCPU box and a 34-minute stall. A cap that never fires and a cap that always fires both
//      "return a result", and both are checked here.
//
// And `powTargetFromRefusal` is a parser pointed at strings a relay controls, so it is checked
// against the live nos.lol text AND against refusals that are not about proof-of-work at all —
// guessing a target out of an unrelated refusal would set the box mining for an event that is going
// to be refused regardless.
//
//   node tests/pow.mjs

import { getEventHash } from 'nostr-tools/pure'
import { createHash } from 'node:crypto'
import { POW_CAP, powDifficulty, powTargetFromRefusal, withNonceTag, mineSync } from '../src/pow.mjs'

let fails = 0
const ok = (n, c) => { console.info(`${c ? 'ok  ' : 'FAIL'} — ${n}`); if (!c) fails++ }

// ── difficulty: bits, against an independent implementation ─────────────────────────────────
{
  // Written out longhand rather than imported — a shared helper would let one bug satisfy both.
  const reference = (hex) => {
    let bits = 0
    for (const byte of Buffer.from(hex, 'hex')) {
      if (byte === 0) { bits += 8; continue }
      for (let b = 7; b >= 0; b--) { if (byte & (1 << b)) return bits; bits++ }
    }
    return bits
  }
  const cases = [
    ['f'.repeat(64), 0],
    ['7' + 'f'.repeat(63), 1],
    ['0' + 'f'.repeat(63), 4],
    ['00' + 'f'.repeat(62), 8],
    ['000f' + 'f'.repeat(60), 12],
    ['0000' + 'f'.repeat(60), 16],
    ['0001' + 'f'.repeat(60), 15],
    ['0'.repeat(64), 256],
  ]
  for (const [hex, want] of cases) {
    ok(`${hex.slice(0, 6)}… is ${want} bits`, powDifficulty(hex) === want && reference(hex) === want)
  }
  // THE nibble-counting bug, stated as its own assertion so it cannot regress quietly.
  ok('000f… is 12 bits, NOT 16 — counting hex zeroes over-reports and commits to work not done',
    powDifficulty('000f' + 'f'.repeat(60)) === 12)
  ok('a non-id returns -1, never 0 — "cannot tell" must not read as "zero bits, fine"',
    powDifficulty('') === -1 && powDifficulty('zz') === -1 && powDifficulty(null) === -1 &&
    powDifficulty('0'.repeat(63)) === -1)
}

// ── parsing a relay's refusal ───────────────────────────────────────────────────────────────
{
  ok('the live nos.lol string yields 28 — the demand, NOT the (12) this event happened to have',
    powTargetFromRefusal('pow: 28 bits needed. (12)') === 28)
  ok('  …and it is still 28 when the achieved figure changes, because that is not what is read',
    powTargetFromRefusal('pow: 28 bits needed. (3)') === 28)
  ok('other phrasings parse', powTargetFromRefusal('difficulty 16 required') === 16 &&
    powTargetFromRefusal('proof-of-work: 20 bits') === 20)
  // The bracket-stripping earns its keep here rather than on the nos.lol string, where 28 happens to
  // come first anyway. Put the achieved figure in front and a parser that reads the raw text mines
  // to 12 — a target the relay never asked for, committed to in the tag.
  ok('a refusal that states the ACHIEVED figure first still yields the demand',
    powTargetFromRefusal('pow required (12 bits achieved) 28 minimum') === 28)

  // THE PAIRED HALF. Everything above is satisfied by "find a number", which would mine against a
  // relay that blocked us for a completely unrelated reason.
  const notPow = [
    'blocked: pubkey is not on the allow list',
    'rate-limited: slow down, 5 events per second',
    'invalid: event created_at is 300 seconds in the future',
    'error: 500',
    '',
  ]
  for (const r of notPow) {
    ok(`"${r || '(empty)'}" is NOT a proof-of-work refusal — null, not a guessed target`,
      powTargetFromRefusal(r) === null)
  }
  ok('a nonsense difficulty is refused rather than mined to',
    powTargetFromRefusal('pow: 0 bits needed') === null && powTargetFromRefusal('pow: 9999 bits') === null)
}

// ── the nonce tag ───────────────────────────────────────────────────────────────────────────
{
  const base = { kind: 1059, created_at: 1, pubkey: 'a'.repeat(64), content: 'x', tags: [['p', 'b'.repeat(64)]] }
  const t1 = withNonceTag(base, 7, 16)
  ok('the nonce tag is NIP-13 shaped: ["nonce", counter, committed target]',
    JSON.stringify(t1.tags.at(-1)) === '["nonce","7","16"]')
  ok('  …and the existing tags survive — a miner that dropped the p tag would seal to nobody',
    t1.tags.some(x => x[0] === 'p' && x[1] === 'b'.repeat(64)))
  const t2 = withNonceTag(t1, 9, 16)
  ok('re-tagging REPLACES rather than appends — two nonce tags make the committed target ambiguous',
    t2.tags.filter(x => x[0] === 'nonce').length === 1 && t2.tags.at(-1)[1] === '9')
  ok('  …and the input is not mutated', base.tags.length === 1 && t1.tags.filter(x => x[0] === 'nonce').length === 1)
}

// ── mining: it really reaches the target, and commits to the right number ────────────────────
{
  const template = { kind: 1059, created_at: 1786492386, pubkey: 'a'.repeat(64), content: 'sealed'.repeat(40), tags: [['p', 'b'.repeat(64)]] }
  const r = mineSync(template, 12, { cap: 20 })
  ok('a 12-bit ask is mined', r.mined === true)
  ok('  …and the id REALLY carries the bits — recomputed here, not taken from the miner\'s word',
    powDifficulty(getEventHash({ ...r.event, id: undefined })) >= 12)
  ok('  …and an independent sha256 over the serialised event agrees on that id',
    createHash('sha256').update(JSON.stringify([0, r.event.pubkey, r.event.created_at, r.event.kind, r.event.tags, r.event.content])).digest('hex') === r.event.id)

  // THE SECOND LIE. Mining to 12 often lands above it; the tag must say what was ASKED.
  const committed = Number(r.event.tags.find(t => t[0] === 'nonce')[2])
  ok('the COMMITTED target is what was asked for, not the luckier figure achieved',
    committed === 12 && r.achieved >= 12)
  ok('  …so the commitment is never a claim the id cannot back', committed <= r.achieved)
  ok('  the p tag survived mining', r.event.tags.some(t => t[0] === 'p'))
}

// ── the cap, in both directions ─────────────────────────────────────────────────────────────
{
  const over = mineSync({ kind: 1059, created_at: 1, pubkey: 'a'.repeat(64), content: 'x', tags: [] }, 28, { cap: 20 })
  ok('28 bits is REFUSED against a 20-bit cap — not attempted, not stalled', over.mined === false && over.code === 'over_cap')
  ok('  …and the reason names the cap and the measured cost, because a bare "refused" sends nobody anywhere',
    /20-bit ceiling/.test(over.reason) && /22k nonces\/sec/.test(over.reason) && /doubles the cost/i.test(over.reason))
  ok('  …and no event comes back — a partially mined event is worse than none', over.event === undefined)

  // THE PAIRED HALF: a cap that refuses everything is indistinguishable from one that works.
  const under = mineSync({ kind: 1059, created_at: 2, pubkey: 'a'.repeat(64), content: 'x', tags: [] }, 8, { cap: 20 })
  ok('8 bits, comfortably under the same cap, still mines — the cap is a ceiling, not a wall', under.mined === true)
  ok('  exactly AT the cap is allowed, not off-by-one refused',
    mineSync({ kind: 1059, created_at: 3, pubkey: 'a'.repeat(64), content: 'x', tags: [] }, 12, { cap: 12 }).mined === true)
  // 16, not the 20 first proposed: cost is linear in payload, and #346's table was measured on a
  // ~3KB event. A real 8.7KB wrap runs at ~22k nonces/sec here, so 20 bits is ~58s on this Mac and
  // roughly five times that on the droplet. The default has to be affordable at OUR payload size.
  ok('the shipped default cap sits below nos.lol\'s 28, and below the 20 that a 3KB measurement suggested',
    POW_CAP < 28 && POW_CAP <= 16 && POW_CAP >= 8)
}

// ── refusals that are not about the cap ─────────────────────────────────────────────────────
{
  const signed = mineSync({ kind: 1059, created_at: 1, pubkey: 'a'.repeat(64), content: 'x', tags: [], sig: 'f'.repeat(128) }, 8)
  ok('an ALREADY-SIGNED event is refused — this is the whole reason mining moved before signing',
    signed.mined === false && signed.code === 'already_signed')
  ok('  …and the reason says to mine the template and then sign, not merely that it failed',
    /Mine the template, then sign/.test(signed.reason))

  // An explicit cap ABOVE the target, so this exercises the budget running out and not the ceiling.
  // Without it the suite silently stopped testing exhaustion the moment POW_CAP moved to 16 — which
  // is exactly what happened, and the distinct codes are the only reason it was visible.
  const exhausted = mineSync({ kind: 1059, created_at: 1, pubkey: 'a'.repeat(64), content: 'x', tags: [] }, 20, { cap: 24, maxIterations: 8 })
  ok('a budget that runs out is `exhausted`, distinct from `over_cap` — one is our ceiling, one is luck',
    exhausted.mined === false && exhausted.code === 'exhausted')

  for (const bad of [0, -1, 'sixteen', null, undefined, 1.5]) {
    ok(`a target of ${JSON.stringify(bad)} is bad_target, not silently treated as zero work`,
      mineSync({ kind: 1059, created_at: 1, pubkey: 'a'.repeat(64), content: 'x', tags: [] }, bad).code === 'bad_target')
  }
}

console.info(`\n${fails ? `POW FAIL — ${fails}` : 'POW PASS — bits not nibbles, the tag commits to what was asked, and the cap both fires and stays out of the way'}`)
process.exit(fails ? 1 : 0)
