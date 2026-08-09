// console_access_list.mjs — what the access list TELLS the owner.
//
// The console's job is to answer one question well enough to act on: who still has access, over
// what, and is this thing I am looking at in force or history. Every function under test here
// makes part of that claim, and every one of them can be wrong in a way that looks fine on
// screen — a card that says "3 active" over three revoked approvals renders beautifully.
//
// So these assert the CLAIM, not the mechanism, and in both directions: the counter must count
// live grants AND not count revoked ones; the scope wording must say "channel" for the admit
// family AND "agent" for the task family. A test that only ever checked one side could not tell
// "labels correctly" from "says the same thing always".
//
//   node tests/console_access_list.mjs

import { fileURLToPath } from 'node:url'
import { groupByGrantee, byLiveThenNewest, scopePhrase, givenOn, isChannelCap }
  from '../console/access-list.mjs'

// Run the check under a pinned timezone rather than the runner's. Asserting UTC-ness on a
// machine that is ALREADY UTC — which CI is — passes no matter what the code does: local and
// UTC agree, so a getDate() bug is invisible exactly where it would ship from. TZ is read once
// at process start, so this has to be a child process.
if (process.env.WAGGLE_TZ_PROBE) {
  process.stdout.write(givenOn(Number(process.env.WAGGLE_TZ_PROBE)))
  process.exit(0)
}

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }

const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64), KEY_C = 'c'.repeat(64)
const grant = (o) => ({ grantee: KEY_A, cap: 'admit', scopeLabel: 'opaque', at: 1000, id: 'f'.repeat(64), live: true, ...o })

// ── Grouping ────────────────────────────────────────────────────────────────────────────────
{
  const groups = groupByGrantee([
    grant({ grantee: KEY_A, at: 100 }),
    grant({ grantee: KEY_B, at: 200 }),
    grant({ grantee: KEY_A, at: 300, cap: 'task' }),
    grant({ grantee: KEY_A, at: 400, cap: 'task-relay' }),
  ])
  check(groups.length === 2, 'three grants to one key and one to another collapse into two cards')
  const a = groups.find(g => g.grantee === KEY_A)
  check(a.grants.length === 3, "and the card for that key carries all three of its approvals")
  check(groups.reduce((n, g) => n + g.grants.length, 0) === 4,
    'and no grant is dropped in the grouping — every one lands on exactly one card')
}

// ── The active counter, both directions ─────────────────────────────────────────────────────
// This is the number an owner reads to decide whether to act. Overcounting reports access that
// was already taken away as still in force; undercounting hides access that is live right now.
{
  const [only] = groupByGrantee([
    grant({ at: 100, live: false }), grant({ at: 200, live: false }), grant({ at: 300, live: false }),
  ])
  check(only.live === 0, 'a key whose every approval was revoked counts ZERO active, not three')
  check(only.grants.length === 3, 'and the revoked approvals are still SHOWN — removed access is history worth seeing')
}
{
  const [only] = groupByGrantee([
    grant({ at: 100, live: false }), grant({ at: 200, live: true }), grant({ at: 300, live: true }),
  ])
  check(only.live === 2, 'and a key with two live and one revoked counts exactly the two — the counter is not stuck at zero')
}

// ── Ordering, in both views ─────────────────────────────────────────────────────────────────
{
  const groups = groupByGrantee([
    grant({ grantee: KEY_A, at: 900, live: false }),   // most recent, but nothing in force
    grant({ grantee: KEY_B, at: 100, live: true }),    // oldest, but live
    grant({ grantee: KEY_C, at: 500, live: true }),
  ])
  check(groups.map(g => g.grantee).join() === [KEY_C, KEY_B, KEY_A].join(),
    'cards holding live access sort above a card that holds none, even when the dead one is newer')
}
{
  const [only] = groupByGrantee([
    grant({ at: 900, live: false }), grant({ at: 100, live: true }), grant({ at: 500, live: true }),
  ])
  check(only.grants.map(g => g.at).join() === '500,100,900',
    'and inside a card: live newest-first, then the removed ones')
}
{
  // The Details table sorts with the same comparator, so the two views cannot disagree about
  // what is in force — the toggle changes the presentation, never the reading.
  const flat = [grant({ at: 1 }), grant({ at: 9, live: false }), grant({ at: 5 })].sort(byLiveThenNewest)
  check(flat.map(g => g.at).join() === '5,1,9', 'the flat Details ordering is the same rule as the card ordering')
}

// ── Scope wording, both families ────────────────────────────────────────────────────────────
// The scope tag is a salted hash of the subject and cannot say what kind of thing it is. The
// CAPABILITY can. Getting this backwards puts a confident lie in the orientation line.
{
  check(isChannelCap('admit') && isChannelCap('admit+read'), 'the admit family is over a channel')
  check(!isChannelCap('task') && !isChannelCap('task+act') && !isChannelCap('task-relay'),
    'and the task family is not — it is over an agent')
  check(/\bchannel\b/.test(scopePhrase(grant({ cap: 'admit' })).text),
    'an opaque admit grant reads as a channel')
  check(/\bagent\b/.test(scopePhrase(grant({ cap: 'task' })).text),
    'and an opaque task grant reads as an agent — the wording is not the same string every time')
  // Caught by loading the page, not by any check above — the wording was assembled from a noun
  // and a fixed article, so every task grant read "in a agent this record does not name". Both
  // directions, because "an" everywhere is the same bug facing the other way.
  check(scopePhrase(grant({ cap: 'task' })).text.includes('in an agent'),
    'the article agrees with the noun — "in AN agent", not "in a agent"')
  check(scopePhrase(grant({ cap: 'admit' })).text.includes('in a channel'),
    'and it is still "in A channel" — the fix is agreement, not "an" pasted everywhere')
  check(scopePhrase(grant({ scopeLabel: 'opaque' })).title,
    'a hidden scope carries the explanation that Hidden is the privacy working, not a failure to load')
  check(scopePhrase(grant({ scopeLabel: 'matches subject' })).title === null,
    'and a resolved scope carries no such explanation, because there is nothing hidden to explain')
  check(scopePhrase(grant({ scopeLabel: 'matches subject' })).text !== scopePhrase(grant({ scopeLabel: 'opaque' })).text,
    'and a resolved scope does not read identically to a hidden one')
}

// ── The date, against the one it sits beside ────────────────────────────────────────────────
// A fixed instant 30 minutes past UTC midnight. In any timezone behind UTC that is still the
// PREVIOUS day locally, which is the whole trap: getDate() and getUTCDate() return different
// numbers, the card and the Details timestamp then disagree about which day access was given,
// and nothing on screen says so.
const JUST_PAST_UTC_MIDNIGHT = 1754_618_400                 // 2025-08-08T02:00:00Z

{
  const iso = new Date(JUST_PAST_UTC_MIDNIGHT * 1000).toISOString()
  check(givenOn(JUST_PAST_UTC_MIDNIGHT) === '8 Aug 2025',
    `the plain date renders as a person writes one (${givenOn(JUST_PAST_UTC_MIDNIGHT)})`)
  check(givenOn(JUST_PAST_UTC_MIDNIGHT).startsWith(String(Number(iso.slice(8, 10)))),
    'and it names the same UTC day as the ISO timestamp in the Details view')

  const { execFileSync } = await import('node:child_process')
  const under = (tz) => execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TZ: tz, WAGGLE_TZ_PROBE: String(JUST_PAST_UTC_MIDNIGHT) }, encoding: 'utf8',
  })
  const behind = under('Pacific/Midway')                    // UTC-11 — locally still 7 August
  const ahead = under('Pacific/Kiritimati')                 // UTC+14 — locally already 8 August
  check(behind === '8 Aug 2025' && ahead === '8 Aug 2025',
    `and it stays the UTC day from UTC-11 and UTC+14 alike (${behind} / ${ahead}) — ` +
    'a local-time format drifts by one and only in some of the world')
  const dayIn = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric' })
    .format(new Date(JUST_PAST_UTC_MIDNIGHT * 1000))
  check(dayIn('Pacific/Midway') !== dayIn('UTC') && dayIn('Pacific/Kiritimati') === dayIn('UTC'),
    `CONTROL FOR THAT CONTROL — the chosen instant really does straddle a day boundary ` +
    `(UTC-11 says ${dayIn('Pacific/Midway')}, UTC says ${dayIn('UTC')}), so the check above is not ` +
    'passing merely because every timezone agrees about it')

  check(givenOn(1) === '1 Jan 1970', 'and the epoch is not off by a month — month indexing is zero-based')
}

// ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────────────
// Everything above has only ever been asked to pass. Prove the live counter is actually derived
// from the grants and is not a constant that happens to match: feed it a card whose approvals
// are all live and confirm the count MOVES.
{
  const [allLive] = groupByGrantee([grant({ at: 1 }), grant({ at: 2 }), grant({ at: 3 })])
  const [allDead] = groupByGrantee([grant({ at: 1, live: false }), grant({ at: 2, live: false })])
  check(allLive.live === 3 && allDead.live === 0,
    'NEGATIVE CONTROL — the active count tracks the data (3 live -> 3, 2 revoked -> 0); a hardcoded number fails one of these')
  check(byLiveThenNewest({ live: true, at: 1 }, { live: false, at: 999 }) < 0,
    'and the comparator genuinely prefers live over recent, rather than sorting by time alone')
}

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
