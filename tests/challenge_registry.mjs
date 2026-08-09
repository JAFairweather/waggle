// challenge_registry.mjs — a nonce may be spent once, and never again.
//
// #311 verifies that a challenge response is signed by the key it claims, and is stateless by
// design, so it cannot tell a first use from a replay. Kind 27492 is ephemeral-range and relays
// broadcast it: anyone who observes a response can present it as their own within the TTL. The
// defence was a comment naming a caller obligation. This is that obligation, and this suite is
// the thing that makes it true rather than intended.
//
// Every assertion here has a way of being wrong that still LOOKS like a working registry:
// a consume that never deletes passes every single-use test that only calls it once; a registry
// that refuses everything passes every replay test and no legitimate one. So the pairs matter.
//
//   node tests/challenge_registry.mjs

import { createChallengeRegistry } from '../src/challenge_registry.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const SUBJECT = 'a'.repeat(64), OTHER = 'b'.repeat(64)
// An injected clock, so expiry is tested by moving time rather than by sleeping. A suite that
// sleeps for its own timeouts is a suite nobody runs.
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (s) => { t += s } } }

// ── The property #311 asked for, in its own words ───────────────────────────────────────────
{
  const r = createChallengeRegistry()
  const issued = r.issue(SUBJECT)
  const first = r.consume(issued.id, SUBJECT)
  const second = r.consume(issued.id, SUBJECT)
  check(first.ok, 'issue -> verify CONSUMES: the first use succeeds')
  check(!second.ok, 'issue -> verify -> SECOND VERIFY REFUSES: the replay is rejected')
  check(/already-used|unknown/.test(second.reason), `and it says why (${second.reason})`)
}

// ── Ids ─────────────────────────────────────────────────────────────────────────────────────
{
  const r = createChallengeRegistry()
  const ids = new Set(Array.from({ length: 200 }, () => r.issue(SUBJECT).id))
  check(ids.size === 200, '200 issued nonces are 200 distinct values — no counter, no collision')
  check([...ids].every(id => /^[0-9a-f]{64}$/.test(id)), 'and every one is 64-hex, the shape every id in this estate uses')
  const r2 = createChallengeRegistry()
  check(!ids.has(r2.issue(SUBJECT).id),
    'a fresh registry does not reproduce an id from another — nonces are not derived from position or time')
}

// ── Expiry, both directions ─────────────────────────────────────────────────────────────────
{
  const c = clock()
  const r = createChallengeRegistry({ ttlSecs: 60, now: c.now })
  const a = r.issue(SUBJECT)
  c.advance(59)
  check(r.consume(a.id, SUBJECT).ok, 'a nonce inside its TTL is still spendable at the last second')
  const b = r.issue(SUBJECT)
  c.advance(61)
  const late = r.consume(b.id, SUBJECT)
  check(!late.ok && /expired/.test(late.reason), 'and one past its TTL is refused as expired, not as unknown')
}

// ── Subject binding, and the oracle it must not become ──────────────────────────────────────
{
  const r = createChallengeRegistry()
  const issued = r.issue(SUBJECT)
  const wrong = r.consume(issued.id, OTHER)
  check(!wrong.ok && /different subject/.test(wrong.reason),
    'a nonce minted for one subject cannot be spent on another')
  const retry = r.consume(issued.id, SUBJECT)
  check(!retry.ok,
    'and the failed attempt BURNED it — a nonce that survives a wrong guess is an oracle you can keep guessing at')
}

// ── Malformed and unknown ───────────────────────────────────────────────────────────────────
{
  const r = createChallengeRegistry()
  for (const bad of [null, undefined, '', 'not-hex', 'A'.repeat(64), 'f'.repeat(63), 'f'.repeat(65), 42, {}]) {
    check(!r.consume(bad, SUBJECT).ok, `a malformed id is refused (${JSON.stringify(bad)})`)
  }
  check(!r.consume('c'.repeat(64), SUBJECT).ok, 'and a well-formed id that was never issued is refused')
}

// ── Construction refuses nonsense rather than defaulting quietly ────────────────────────────
{
  for (const bad of [0, -1, NaN, Infinity, 'soon']) {
    let threw = false
    try { createChallengeRegistry({ ttlSecs: bad }) } catch { threw = true }
    check(threw, `a registry refuses to be built with ttlSecs=${String(bad)} rather than picking one for you`)
  }
  let threw = false
  try { createChallengeRegistry().issue('') } catch { threw = true }
  check(threw, 'and a nonce cannot be issued unbound to a subject')
}

// ── Housekeeping does not change decisions ──────────────────────────────────────────────────
{
  const c = clock()
  const r = createChallengeRegistry({ ttlSecs: 30, now: c.now })
  const keep = r.issue(SUBJECT)
  r.issue(SUBJECT); r.issue(SUBJECT)
  c.advance(31)
  const fresh = r.issue(SUBJECT)
  check(r.sweep() === 3, 'sweep drops exactly the expired records')
  check(r.consume(fresh.id, SUBJECT).ok, 'and leaves a live one spendable')
  check(!r.consume(keep.id, SUBJECT).ok, 'while the swept one stays refused')
}

// ── A durable store is just a Map ───────────────────────────────────────────────────────────
// The join request outlives a restart; the challenge does not. Both use this registry, so the
// store is injected. This proves the registry keeps no state of its own that a restart would lose.
{
  const shared = new Map()
  const before = createChallengeRegistry({ store: shared })
  const issued = before.issue(SUBJECT)
  const after = createChallengeRegistry({ store: shared })   // stands in for a process restart
  check(after.consume(issued.id, SUBJECT).ok,
    'a nonce issued before a restart is spendable after it, when the store persists')
  check(!before.consume(issued.id, SUBJECT).ok,
    'and spending it through one handle spends it for both — the store is the truth, not the instance')
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Almost every check above is a refusal. A registry whose consume always returned {ok:false}
// would pass them all. Prove the accept path is real and is what the refusals are distinguished
// from — and prove the replay refusal is caused by the FIRST use, not by the id being unusable.
{
  const r = createChallengeRegistry()
  const a = r.issue(SUBJECT), b = r.issue(SUBJECT)
  check(r.consume(a.id, SUBJECT).ok && r.consume(b.id, SUBJECT).ok,
    'NEGATIVE CONTROL — two freshly issued nonces both succeed, so this registry does not simply refuse everything')

  const c = r.issue(SUBJECT)
  const neverSpent = createChallengeRegistry()
  const twin = neverSpent.issue(SUBJECT)
  check(r.consume(c.id, SUBJECT).ok && !r.consume(c.id, SUBJECT).ok && neverSpent.consume(twin.id, SUBJECT).ok,
    'and the second refusal is caused by the first SPEND — an identical unspent nonce elsewhere still works')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
