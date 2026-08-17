// relay_set.mjs — the outbound relay set, and the two ways a "fix" to it silently makes things worse.
//
// #345: the sealed lane published to exactly two relays and one of them began refusing, so a single
// outage became a silent delivery stop. The fix is more relays, defined once. Both halves of that
// have a failure mode that a suite which only checks the happy path cannot see:
//
//   * **A parser that drops too much.** `relaySet` throws away entries it will not dial. Every
//     assertion that it refuses something is satisfied equally well by a function that refuses
//     EVERYTHING and falls back to the default — which would look, in production, exactly like an
//     operator's `RELAYS=...` being ignored. So every refusal below is paired with a legitimate
//     entry that must still get through, in the same call.
//   * **A fallback that hides an empty set.** Falling back when the input is empty is correct;
//     falling back when the input was *fine* is not. Both are "returns a non-empty array".
//
// And `thinRelaySet` is an alarm, so it is checked in both directions: it must fire on a thin set
// AND stay silent on a healthy one. An alarm that always fires and one that never fires fail
// identically at the moment somebody needs it.
//
//   node tests/relay_set.mjs

import { DEFAULT_PUBLIC_RELAYS, REDUNDANCY_FLOOR, parseRelaySet, relaySet, thinRelaySet } from '../src/relays.mjs'

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

// ── the default set ─────────────────────────────────────────────────────────────────────────
{
  check(DEFAULT_PUBLIC_RELAYS.length >= REDUNDANCY_FLOOR,
    `the default set carries ${DEFAULT_PUBLIC_RELAYS.length} relays, at or above the floor of ${REDUNDANCY_FLOOR} — this is the whole point of #345`)
  check(DEFAULT_PUBLIC_RELAYS.every(u => /^wss:\/\//.test(u)),
    'every default is wss — a ws:// relay would carry the envelope in clear, which is the one thing the sealed lane claims it does not do')
  const hosts = DEFAULT_PUBLIC_RELAYS.map(u => u.replace(/\/+$/, '').toLowerCase())
  check(new Set(hosts).size === hosts.length,
    'no default appears twice — a duplicated host is redundancy that is not there, and it inflates the fan-out ratio while nothing is behind it')
  check(Object.isFrozen(DEFAULT_PUBLIC_RELAYS),
    'the default set is frozen — a caller that push()es onto it would change the default for every other caller in the process')
}

// ── parsing: what gets through, not just what is refused ────────────────────────────────────
{
  const out = relaySet('wss://a.example, wss://b.example')
  check(out.length === 2 && out[0] === 'wss://a.example' && out[1] === 'wss://b.example',
    'a plain comma list is parsed, in order')
  check(relaySet('wss://a.example wss://b.example').length === 2,
    'whitespace separates too — an operator pasting a space-separated list is not silently reduced to one relay')
}
{
  // THE PAIRED ASSERTION. Each of these has one entry that must be refused and one that must
  // survive, in the SAME call, so "refuses the dangerous thing" cannot pass as "refuses everything".
  const cases = [
    ['ws://plain.example, wss://good.example', 'a ws:// relay is dropped'],
    ['http://web.example, wss://good.example', 'an http:// URL is dropped'],
    ['not-a-url, wss://good.example', 'a bare word is dropped'],
    ['wss://, wss://good.example', 'a scheme with no host is dropped'],
    ['   , wss://good.example', 'an empty entry from a trailing comma is dropped'],
  ]
  for (const [input, label] of cases) {
    const out = relaySet(input)
    check(out.length === 1 && out[0] === 'wss://good.example',
      `${label} — AND wss://good.example still gets through, so this is not a parser that refuses everything`)
  }
}
{
  const out = relaySet('wss://dup.example, wss://DUP.example/, wss://dup.example')
  check(out.length === 1 && out[0] === 'wss://dup.example',
    'one host spelled three ways is one relay — case and a trailing slash do not make a second copy')
  const both = relaySet('wss://dup.example, wss://DUP.example, wss://other.example')
  check(both.length === 2 && both.includes('wss://other.example'),
    'and de-duplication does not swallow a genuinely different host alongside it')
}

// ── the fallback: only when there is nothing ────────────────────────────────────────────────
{
  check(relaySet('').length === DEFAULT_PUBLIC_RELAYS.length,
    'an unset variable falls back to the default — "" must mean "I did not set this", never "publish to nowhere"')
  check(relaySet(undefined).length === DEFAULT_PUBLIC_RELAYS.length, 'so does undefined')
  check(relaySet('ws://only-bad.example').length === DEFAULT_PUBLIC_RELAYS.length,
    'a list with nothing dialable in it falls back rather than returning [] — a fan-out to [] reports 0/0 and reads as a send that landed nowhere')
  const custom = relaySet('wss://mine.example, wss://mine2.example')
  check(custom.length === 2 && !custom.includes('wss://nos.lol'),
    'but a set the operator DID supply wins outright — the default is not merged in, which would publish to relays they deliberately left out')
  // The fallback must be COPIED, not handed back by reference. This was asserted once by calling
  // relaySet twice with two array literals — which compares two fresh arrays and can never fail.
  // Hold the same array and look at IT afterwards, or the check is decoration.
  const myFallback = ['wss://explicit.example']
  const fb = relaySet('', myFallback)
  check(fb.length === 1 && fb[0] === 'wss://explicit.example', 'a caller may supply its own fallback')
  fb.push('wss://mutated.example')
  check(myFallback.length === 1,
    'the returned array is a copy — pushing onto it did not edit the caller\'s own fallback array')
  const d = relaySet('')
  d.push('wss://mutated.example')   // throws if this IS the frozen default rather than a copy of it
  check(DEFAULT_PUBLIC_RELAYS.length === 4 && !DEFAULT_PUBLIC_RELAYS.includes('wss://mutated.example'),
    'and the module default is likewise untouched by what a caller does to the array it was given')
}

// ── the alarm, in both directions ───────────────────────────────────────────────────────────
{
  check(thinRelaySet(DEFAULT_PUBLIC_RELAYS) === null,
    'a healthy set raises nothing — an alarm that always fires is an alarm nobody reads')
  check(thinRelaySet([]) !== null && /reads as a send/.test(thinRelaySet([])),
    'no relays at all is named, and the reason says why 0/0 is not a success')
  const two = thinRelaySet(['wss://a.example', 'wss://b.example'])
  check(two !== null && /only 2 relay/.test(two) && /#345/.test(two),
    'the exact pair that caused #345 is named, WITH the count and the issue — a bare "thin" sends nobody anywhere')
  check(thinRelaySet(['wss://a.example', 'wss://b.example', 'wss://c.example']) === null,
    'and three is silent, so the floor is a floor and not a slope')
  check(thinRelaySet(null) !== null && thinRelaySet(undefined) !== null,
    'a missing list is thin, not healthy — being unable to see the set is not the same as the set being fine')
}

// ── the loopback exemption, and how narrow it is (#589) ─────────────────────────────────────
// `agent-inbox`/`agent-send` accepted `ws://` to any host before they took their defaults from this
// module. Routing them through it would have removed that, and a local relay is how both tools are
// driven without a network — so the exemption exists. Every assertion here is paired, because a
// scheme rule asserted only to refuse cannot be told from one that refuses everything.
{
  const LOOP = 'ws://127.0.0.1:7447'
  check(relaySet(LOOP, ['wss://fb.example'], { allowLoopbackWs: true })[0] === LOOP,
    'an explicit loopback ws:// is admitted when the caller opts in — this is how the tools are driven against a local relay')
  check(relaySet(LOOP, ['wss://fb.example'])[0] === 'wss://fb.example',
    'and is NOT admitted by default — the option is opt-in, so no existing caller silently gained it')
  check(relaySet('ws://localhost:7447', ['wss://fb.example'], { allowLoopbackWs: true })[0] === 'ws://localhost:7447' &&
    relaySet('ws://[::1]:7447', ['wss://fb.example'], { allowLoopbackWs: true })[0] === 'ws://[::1]:7447',
    'all three loopback spellings are admitted — a rule that covers only 127.0.0.1 sends the next reader to add another exemption')
  // The one that matters. A prefix match here admits a remote host whose NAME starts with a
  // loopback address, which is the classic way an "it's only local" rule becomes a public one.
  check(relaySet('ws://127.0.0.1.evil.example', ['wss://fb.example'], { allowLoopbackWs: true })[0] === 'wss://fb.example',
    'NEGATIVE CONTROL — ws://127.0.0.1.evil.example is REFUSED even with the option on: it is a remote host, not a loopback one')
  check(relaySet('ws://relay.example.org', ['wss://fb.example'], { allowLoopbackWs: true })[0] === 'wss://fb.example',
    'and an ordinary remote ws:// is still refused — the exemption is about loopback, not about ws://')
  check(relaySet(`wss://real.example,${LOOP}`, ['wss://fb.example'], { allowLoopbackWs: true }).join(' ') === `wss://real.example ${LOOP}`,
    'a mixed list keeps both — the exemption widens what is admitted, it does not replace the wss rule')
  check(relaySet('', ['wss://fb.example'], { allowLoopbackWs: true })[0] === 'wss://fb.example',
    'and an empty value still falls back, so the option changes nothing about the default path')
}

// ── "unset" is not "nothing survived" (#591) ────────────────────────────────────────────────
// `relaySet` collapses both into an empty parse and returns the fallback. For a reader that is fine;
// for a tool that signs and fans out it is a REDIRECTION — the operator names one private relay and
// the wrap's `p` tag and timing go to four public ones instead, at exit 0, with `thinRelaySet` silent
// because four is above the floor. `parseRelaySet` is the function that can tell them apart, so the
// discrimination itself is what is asserted here, not just the shape of the return.
{
  const unset = parseRelaySet('')
  check(unset.kept.length === 0 && unset.dropped.length === 0,
    'an unset value drops NOTHING — there was nothing to drop, and this is the case where falling back is correct')
  const refused = parseRelaySet('ws://relay.internal.example:7777')
  check(refused.kept.length === 0 && refused.dropped.length === 1 && refused.dropped[0] === 'ws://relay.internal.example:7777',
    'a value that is entirely undialable reports WHAT it refused — the caller cannot name it in an error message otherwise')
  // THE DISCRIMINATION. Both of these give relaySet an empty parse and the same fallback; if the two
  // are not distinguishable here, nothing downstream can distinguish them either.
  check(unset.dropped.length !== refused.dropped.length,
    'and the two are TOLD APART — this is the single fact `relaySet` cannot report, and the reason this function exists')
  check(relaySet('') .length === DEFAULT_PUBLIC_RELAYS.length && relaySet('ws://relay.internal.example:7777').length === DEFAULT_PUBLIC_RELAYS.length,
    'while relaySet still answers identically to both, unchanged — the module-level fallback contract is not what moved')

  const mixed = parseRelaySet('ws://relay.internal.example:7777, wss://good.example')
  check(mixed.kept.length === 1 && mixed.kept[0] === 'wss://good.example' && mixed.dropped.length === 1,
    'a partial drop keeps the good entry AND names the bad one — not a parser that reports everything, and not one that reports nothing')
  const allGood = parseRelaySet('wss://a.example, wss://b.example')
  check(allGood.kept.length === 2 && allGood.dropped.length === 0,
    'NEGATIVE CONTROL — a set with nothing wrong in it drops nothing: an alarm that always fires reads the same as one that never does')
  const dup = parseRelaySet('wss://dup.example, wss://DUP.example/')
  check(dup.kept.length === 1 && dup.dropped.length === 0,
    'a DUPLICATE is not a drop — the operator did get the relay they named, once, and calling that a refusal would send them hunting')
  const loop = parseRelaySet('ws://127.0.0.1:7447', { allowLoopbackWs: true })
  check(loop.kept.length === 1 && loop.dropped.length === 0 && parseRelaySet('ws://127.0.0.1:7447').dropped.length === 1,
    'the loopback option reaches this function too, and without it the same value is a drop rather than a silent disappearance')
}

console.log(`\n${pass ? 'RELAY SET PASS — the parser lets good entries through, and the alarm can both fire and stay quiet' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
