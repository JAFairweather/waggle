// relay_wall.mjs — the membership-wall alarm's judgement (#447).
//
// What this suite is really defending: an alarm that has only ever passed is indistinguishable from
// one that never fires. Every assertion below that a probe REFUSES is paired with one that a
// legitimate value still gets through, and the `intact` verdict is checked for reachability, not
// merely for correctness on one happy path.
//
// Run: node tests/relay_wall.mjs   (exit 0 = pass, 1 = fail)

import { buildAuthEvent, classifyAuthReply, wallVerdict, EXIT, OBSERVED, AUTH_KIND } from '../src/relay_wall.mjs'

let n = 0, fails = 0
const ok = (name, cond, detail = '') => {
  n++
  if (cond) return console.log(`  ok   ${name}`)
  fails++
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}
const threw = (fn) => { try { fn(); return false } catch { return true } }

console.log('relay membership wall (#447)')

// --- the AUTH event -----------------------------------------------------------------------------
{
  const ev = buildAuthEvent({ relayUrl: 'wss://relay.example', challenge: 'abc123', created_at: 1000 })
  const tag = (k) => (ev.tags.find(t => t[0] === k) || [])[1]
  ok(`AUTH event is kind ${AUTH_KIND}`, ev.kind === AUTH_KIND)
  ok('it binds the challenge', tag('challenge') === 'abc123')
  ok('it binds the relay too — a response carrying only the challenge is replayable elsewhere',
    tag('relay') === 'wss://relay.example')
  ok('content is empty, as NIP-42 specifies', ev.content === '')

  // Both directions: it refuses incomplete input, AND it accepts complete input (asserted above).
  ok('refuses a missing challenge', threw(() => buildAuthEvent({ relayUrl: 'wss://r', created_at: 1 })))
  ok('refuses a missing relay', threw(() => buildAuthEvent({ challenge: 'c', created_at: 1 })))
  ok('refuses a non-integer created_at', threw(() => buildAuthEvent({ relayUrl: 'wss://r', challenge: 'c', created_at: 1.5 })))
}

// --- reading the relay's reply ------------------------------------------------------------------
{
  const ID = 'e'.repeat(64)
  const read = (frames, sawChallenge = true) => classifyAuthReply({ frames, eventId: ID, sawChallenge })

  ok('OK true -> authenticated', read([['OK', ID, true, 'welcome']]).observed === OBSERVED.authenticated)
  ok('OK false -> refused', read([['OK', ID, false, 'restricted: not a member']]).observed === OBSERVED.refused)
  ok('  …and it carries the relay\'s stated reason, which is what an operator acts on',
    read([['OK', ID, false, 'restricted: not a member']]).detail === 'restricted: not a member')

  // Matching on id rather than position. A relay interleaves NOTICE and other OKs, and reading
  // somebody else's verdict as ours is a silent wrong answer in either direction.
  ok('an OK naming a DIFFERENT event is not mistaken for ours',
    read([['OK', 'f'.repeat(64), true, 'not ours']]).observed === OBSERVED.error)
  ok('  …and ours is still found when it arrives after unrelated traffic',
    read([['NOTICE', 'chatter'], ['OK', 'f'.repeat(64), true, 'other'], ['OK', ID, false, 'no']]).observed === OBSERVED.refused)

  ok('no challenge issued -> noChallenge, not refused', read([], false).observed === OBSERVED.noChallenge)
  ok('no OK at all -> error, never a silent pass', read([['NOTICE', 'hi']]).observed === OBSERVED.error)
  ok('a non-boolean verdict is an error, not a guess',
    read([['OK', ID, 'true', 'stringly typed']]).observed === OBSERVED.error)
  ok('frames not an array -> error', classifyAuthReply({ frames: null, eventId: ID, sawChallenge: true }).observed === OBSERVED.error)
}

// --- the verdict: the alarm fires ---------------------------------------------------------------
const REFUSED = { observed: OBSERVED.refused, detail: 'restricted: not a member' }
const ADMITTED = { observed: OBSERVED.authenticated, detail: '' }
{
  const v = wallVerdict({ mustBeRefused: { observed: OBSERVED.authenticated, detail: 'welcome' }, mustBeAdmitted: ADMITTED })
  ok('a key with no grant authenticating -> breach', v.state === 'breach')
  ok('  …exit code 2', v.exitCode === EXIT.breach && v.exitCode === 2)
  ok('  …and it says the wall is not enforcing, not merely that something failed',
    /not enforcing/i.test(v.reason))
  ok('  …and asks for a human', v.needsHuman === true)

  // The alarm must not be softened by a bad control run. The wall is provably down either way.
  ok('breach still reported when the control ALSO failed',
    wallVerdict({ mustBeRefused: { observed: OBSERVED.authenticated }, mustBeAdmitted: { observed: OBSERVED.unreachable } }).state === 'breach')
  ok('breach still reported when no control was configured at all',
    wallVerdict({ mustBeRefused: { observed: OBSERVED.authenticated }, mustBeAdmitted: null }).state === 'breach')
}

// --- the verdict: a refusal alone is NOT a pass --------------------------------------------------
// This is the whole point of the module. Each case below is a refusal that must not be read as a
// working wall, and each must be distinguishable from the others by its stated reason.
{
  const noControl = wallVerdict({ mustBeRefused: REFUSED, mustBeAdmitted: null })
  ok('refused + no control -> inconclusive, NOT intact', noControl.state === 'inconclusive')
  ok('  …exit code 3, and 3 is not 0', noControl.exitCode === EXIT.inconclusive && noControl.exitCode === 3 && EXIT.inconclusive !== EXIT.intact)
  ok('  …and the reason names the missing control, so the operator knows what to fix',
    /control key/i.test(noControl.reason))

  const deadRelay = wallVerdict({ mustBeRefused: REFUSED, mustBeAdmitted: { observed: OBSERVED.unreachable } })
  ok('refused + control also refused/unreachable -> inconclusive', deadRelay.state === 'inconclusive')
  ok('  …and the reason says a relay refusing everyone looks identical to a working wall',
    /refusing everyone/i.test(deadRelay.reason))
  ok('  …and it does NOT claim the missing-control problem; the two diagnoses are exclusive',
    !/no control key was configured/i.test(deadRelay.reason))

  const silent = wallVerdict({ mustBeRefused: { observed: OBSERVED.noChallenge }, mustBeAdmitted: ADMITTED })
  ok('relay never issued a challenge -> inconclusive, never intact', silent.state === 'inconclusive')
  ok('  …flagged for a human, because it may mean the wall is down', silent.needsHuman === true)
  ok('  …and it does not report the wall as up', !/is enforcing/i.test(silent.reason))

  // `needsHuman` drives "⚠ this one needs a human, not a retry", so it is a ROUTING decision sitting
  // on top of the verdict, and it needs both directions like anything else. Asserting only that
  // `noChallenge` pages someone leaves `needsHuman: true` — page on everything — passing the whole
  // suite: every relay restart and network blip becomes an alarm, which is how an alarm stops being
  // read at all. The fail-open direction is covered above; this is the same fault on the other axis.
  for (const bad of [OBSERVED.unreachable, OBSERVED.timedOut, OBSERVED.error]) {
    const v = wallVerdict({ mustBeRefused: { observed: bad }, mustBeAdmitted: ADMITTED })
    ok(`must-be-refused '${bad}' -> inconclusive, not a pass`, v.state === 'inconclusive' && v.exitCode === 3)
    ok(`  …and '${bad}' is explicitly not called evidence the wall is up`, /not evidence/i.test(v.reason))
    ok(`  …and '${bad}' is a retry, NOT a page — a transport fault is not the wall coming down`,
      v.needsHuman === false, String(v.needsHuman))
  }

  ok('a missing must-be-refused result is inconclusive, not a pass',
    wallVerdict({ mustBeAdmitted: ADMITTED }).state === 'inconclusive')
}

// --- NEGATIVE CONTROL: intact is reachable, and reachable ONLY the right way ---------------------
// Everything above asserts a refusal. A verdict function hard-coded to return `inconclusive` passes
// every one of them while being useless. These are the assertions that catch that.
{
  const good = wallVerdict({ mustBeRefused: REFUSED, mustBeAdmitted: ADMITTED })
  ok('NEGATIVE CONTROL — refused + admitted -> intact', good.state === 'intact')
  ok('NEGATIVE CONTROL — intact exits 0', good.exitCode === EXIT.intact && good.exitCode === 0)
  ok('NEGATIVE CONTROL — and it says why that combination is what makes the refusal meaningful',
    /is enforcing/i.test(good.reason))
  ok('NEGATIVE CONTROL — intact does not ask for a human', good.needsHuman === false)

  // The property, stated exhaustively rather than by one example: nothing except a genuinely
  // admitted control can produce `intact`. If a new OBSERVED value is ever added, this fails until
  // somebody decides on purpose which side it belongs on.
  const notAdmitted = Object.values(OBSERVED).filter(o => o !== OBSERVED.authenticated)
  const leaks = notAdmitted.filter(o => wallVerdict({ mustBeRefused: REFUSED, mustBeAdmitted: { observed: o } }).state === 'intact')
  ok(`no control observation other than 'authenticated' can yield intact (checked ${notAdmitted.length})`,
    leaks.length === 0, leaks.join(', '))

  // And the mirror: nothing except a genuine refusal on the must-be-refused side yields intact.
  const notRefused = Object.values(OBSERVED).filter(o => o !== OBSERVED.refused)
  const leaks2 = notRefused.filter(o => wallVerdict({ mustBeRefused: { observed: o }, mustBeAdmitted: ADMITTED }).state === 'intact')
  ok(`no must-be-refused observation other than 'refused' can yield intact (checked ${notRefused.length})`,
    leaks2.length === 0, leaks2.join(', '))
}

// --- exit codes are distinct, or the timer cannot tell these apart -------------------------------
{
  const codes = Object.values(EXIT)
  ok('every verdict maps to a distinct exit code', new Set(codes).size === codes.length)
  ok('inconclusive is 3, matching tripwire.mjs and verify-firewall.sh', EXIT.inconclusive === 3)
}

console.log(`\n${n - fails}/${n} passed`)
process.exit(fails ? 1 : 0)
