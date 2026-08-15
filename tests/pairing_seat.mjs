// tests/pairing_seat.mjs — the three decisions `tools/join.mjs` makes after custody is proved.
//
// The #491 review found every defect in the tool and none in the module, because `tools/join.mjs`
// runs its ceremony at import and no test could reach any of it. These are those decisions, now
// reachable. Each assertion is paired with one in the other direction: a guard that only ever
// refuses cannot be told apart from a guard that refuses everything.

import { seatPlan, timeoutReport, firstTruthy } from '../src/pairing_seat.mjs'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`FAIL — ${label}`) } }

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const URI = 'bunker://' + 'c'.repeat(64) + '?relay=wss://relay.example'
const NSEC = 'nsec1' + 'q'.repeat(58)

console.log('== seatPlan — the identity is part of the seat ==')

const clean = seatPlan({ identityPubkey: A, pairingUri: URI, clientNsec: NSEC })
ok(clean.ok, 'an empty directory is a legal seat')
ok(clean.files.some(f => f.name === 'identity' && f.value === A),
  'THE MUST-FIX — the proved identity is WRITTEN, not merely printed')
ok(clean.files.length === 3, 'three files: identity, bunker-uri, bunker-client')
ok(clean.files.map(f => f.name).sort().join(',') === 'bunker-client,bunker-uri,identity',
  'and they are exactly those three — nothing else lands in a seat')
ok(clean.files.find(f => f.name === 'bunker-uri').value === URI
  && clean.files.find(f => f.name === 'bunker-client').value === NSEC,
  'NEGATIVE CONTROL — the two files that already worked still carry their own values')

// The failure this fix exists to prevent: a seat that names no identity. If `identity` were ever
// dropped from the plan, everything downstream pins to whatever the bunker reports instead.
ok(!clean.files.every(f => f.name !== 'identity'),
  'a seat with no identity file is what silently pins to the wrong key')

const lower = seatPlan({ identityPubkey: A.toUpperCase(), pairingUri: URI, clientNsec: NSEC })
ok(lower.ok && lower.files[0].value === A, 'the identity is normalised to lowercase hex')

// A seat that always wrote the same identity would pass every assertion above. Two different keys
// must produce two different seats, or the file is decoration rather than a record.
const other = seatPlan({ identityPubkey: B, pairingUri: URI, clientNsec: NSEC })
ok(other.ok && other.files.find(f => f.name === 'identity').value === B,
  'a different identity is carried through — the file records what was proved, not a constant')
ok(clean.files.find(f => f.name === 'identity').value
  !== other.files.find(f => f.name === 'identity').value,
  'and the two seats differ, so the value is genuinely threaded from the challenge')

ok(!seatPlan({ identityPubkey: 'nope', pairingUri: URI, clientNsec: NSEC }).ok,
  'a non-hex identity is refused')
ok(/64-hex identity/.test(seatPlan({ identityPubkey: 'nope', pairingUri: URI, clientNsec: NSEC }).reason),
  'and the reason says WHICH value was wrong, not merely that something was')
ok(!seatPlan({ identityPubkey: A, pairingUri: '', clientNsec: NSEC }).ok, 'a missing URI is refused')
ok(!seatPlan({ identityPubkey: A, pairingUri: URI, clientNsec: '' }).ok, 'a missing client key is refused')

console.log('== seatPlan — refuses rather than overwrites ==')

for (const name of ['identity', 'bunker-uri', 'bunker-client']) {
  const r = seatPlan({ identityPubkey: A, pairingUri: URI, clientNsec: NSEC, present: [name] })
  ok(!r.ok, `an existing ${name} refuses the whole write`)
  ok(r.reason.includes(name), `and the refusal NAMES ${name}, so the operator knows what is there`)
}

const both = seatPlan({ identityPubkey: A, pairingUri: URI, clientNsec: NSEC, present: ['bunker-uri', 'identity'] })
ok(!both.ok && both.reason.includes('bunker-uri') && both.reason.includes('identity'),
  'two clashes are both named')

ok(seatPlan({ identityPubkey: A, pairingUri: URI, clientNsec: NSEC, present: ['README', 'notes.txt'] }).ok,
  'NEGATIVE CONTROL — unrelated files in the directory do NOT block a seat: this guard refuses '
  + 'credentials being clobbered, not any non-empty directory')

console.log('== timeoutReport — the reason, not only the refusal ==')

const quiet = timeoutReport(0)
ok(quiet.exitCode === 4, 'no tokens at all still exits 4')
ok(quiet.lines.join(' ').includes('no pairing token arrived'),
  'and says the relay carried nothing')

const refused = timeoutReport(3)
ok(refused.exitCode === 5, 'THE BUG — tokens arrived and were refused: a DIFFERENT exit code')
ok(refused.lines.join(' ').includes('3 pairing tokens'), 'the count is reported')
ok(!refused.lines.join(' ').includes('no pairing token arrived'),
  'and it does NOT say nothing arrived, which was false and sent the operator to the relay')
ok(refused.lines.join(' ').includes('fault is in the token, not the lane'),
  'it points at the token instead')

const one = timeoutReport(1)
ok(one.lines.join(' ').includes('1 pairing token arrived') && one.lines.join(' ').includes('was refused'),
  'one refusal is singular — the fixture that would have caught a name with a space')
ok(timeoutReport(2).lines.join(' ').includes('were refused'), 'two is plural')

console.log('== firstTruthy — the winner cancels the losers ==')

{
  // The exact shape of the bug: one task answers fast, the others hold a long timer.
  const cancelled = []
  const slow = (id, ms) => reg => new Promise(res => {
    const t = setTimeout(() => res(null), ms)
    reg.onCancel(() => { clearTimeout(t); cancelled.push(id); res(null) })
  })
  const fast = reg => new Promise(res => { const t = setTimeout(() => res({ won: true }), 5); reg.onCancel(() => clearTimeout(t)) })

  const t0 = Date.now()
  const won = await firstTruthy([slow('a', 60_000), fast, slow('b', 60_000)])
  const elapsed = Date.now() - t0

  ok(won && won.won === true, 'the truthy result is returned')
  ok(elapsed < 2000, `THE BUG — it does not wait for the slow relays (${elapsed}ms, was the full --wait window)`)
  ok(cancelled.sort().join(',') === 'a,b', 'and both losers were cancelled')
}

{
  // NEGATIVE CONTROL. If every task resolves falsy, the answer must be null — not the first falsy
  // value dressed up as a win, and not a hang.
  const all = await firstTruthy([() => Promise.resolve(null), () => Promise.resolve(null), () => Promise.resolve(false)])
  ok(all === null, 'NEGATIVE CONTROL — every task falsy resolves null, so the timeout path still runs')
}

{
  const withThrow = await firstTruthy([
    () => { throw new Error('sync boom') },
    () => Promise.reject(new Error('async boom')),
    () => Promise.resolve({ won: 'survivor' }),
  ])
  ok(withThrow && withThrow.won === 'survivor', 'a throwing task does not sink the ones that work')
}

{
  const allThrow = await firstTruthy([() => Promise.reject(new Error('x')), () => { throw new Error('y') }])
  ok(allThrow === null, 'and if they all throw, the answer is null rather than a hang')
}

ok(await firstTruthy([]) === null, 'no tasks resolves null rather than hanging')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.log('FAILURES ABOVE'); process.exit(1) }
