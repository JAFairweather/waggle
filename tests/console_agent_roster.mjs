// console_agent_roster.mjs — the route panel picks an agent instead of taking a paste (#413).
//
// The exposure being closed is not a rejected paste. An npub is 63 characters of base32 with no
// prefix a person reads, so a WRONG one decodes cleanly, signs, publishes, and routes a channel's
// mentions to a different admitted agent. Nothing downstream can catch that, because routing to
// another admitted participant is a legitimate operation — so the only place it is catchable is
// before the paste.
//
// Three things this suite holds, and each of them is a way the fix could be quietly undone:
//
//  1. The roster comes from the state `freshBridge()` ALREADY verified. If that function goes back
//     to returning a bare bridge key, the picker needs a second fetch, and a second fetch is a
//     second trust assumption. Asserted structurally against the source.
//  2. Nothing is filtered out. A paused or removed agent must be selectable-and-marked, never
//     absent — an agent that is on the roster and not in the list sends the operator hunting.
//  3. The vocabulary has one owner. `agents.html` used to declare its own STATUSES/STATUS_LABEL;
//     a second copy drifts in exactly the direction where `revoked` reads as something reassuring.
//
//   node tests/console_agent_roster.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nip19 } from 'nostr-tools'
import { STATUSES, STATUS_LABEL, statusLabel, validAgent, rosterAgents, shortNpub, agentOptionText }
  from '../console/agent-roster.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONSOLE = join(ROOT, 'console')

let pass = true
const check = (cond, label) => { console.log(`${cond ? 'ok  ' : 'FAIL'} — ${label}`); if (!cond) pass = false }
const inconclusive = (why) => {
  console.error(`console_agent_roster: INCONCLUSIVE — ${why}`)
  console.error('  This is NOT an all-clear: the invariant was not exercised.')
  process.exit(3)
}

// Deliberately LETTERED hex, not `'1'.repeat(64)`. The first draft used digits, and the
// uppercase-refusal check below passed its input through `toUpperCase()` unchanged — a probe that
// loses its own input reports a pass for a case it never ran. It failed, correctly, as a FAIL on a
// correct implementation.
const key = (pair) => pair.repeat(32)
const A = key('ab'), B = key('bc'), C = key('cd'), D = key('de')

// ---- 1. the shape check, both directions --------------------------------------------------------
check(validAgent({ pubkey: A, status: 'admitted', label: 'My Dude' }), 'a well-formed admitted agent is accepted')
check(validAgent({ pubkey: A, status: 'revoked', label: null }), 'a null label is accepted — the roster carries unnamed keys')
check(!validAgent({ pubkey: 'npub1short', status: 'admitted' }), 'a non-hex pubkey is refused: the picker value is what gets signed')
check(!validAgent({ pubkey: A.toUpperCase(), status: 'admitted' }), 'uppercase hex is refused rather than silently lowercased')
check(!validAgent({ pubkey: A, status: 'banished' }), 'a status this console has never heard of is refused, not rendered raw')
check(!validAgent({ pubkey: A, status: 'admitted', label: 'x'.repeat(65) }), 'an over-long label is refused')
check(!validAgent({ pubkey: A, status: 'admitted', label: 'café' }), 'a non-ASCII label is refused — the wire form is printable ASCII')
check(!validAgent(null) && !validAgent('a string'), 'a non-object is refused without throwing')

// ---- 2. ordering, and nothing dropped -----------------------------------------------------------
const state = { agents: [
  { pubkey: C, status: 'revoked', label: 'Gone' },
  { pubkey: A, status: 'paused', label: 'Sleepy' },
  { pubkey: B, status: 'admitted', label: 'My Dude' },
  { pubkey: D, status: 'admitted', label: 'Dennis' },
] }
const ordered = rosterAgents(state)
check(ordered.length === 4, `every agent survives the sort (got ${ordered.length} of 4)`)
check(ordered.map(a => a.status).join(',') === 'admitted,admitted,paused,revoked',
  `live first, then paused, then removed (got ${ordered.map(a => a.status).join(',')})`)
check(ordered[0].label === 'Dennis' && ordered[1].label === 'My Dude',
  'agents of equal status are ordered by label, so the list does not reshuffle between loads')

// NEGATIVE CONTROL — the sort is doing work. Feeding it an already-correct order proves nothing;
// the input above is deliberately reversed, and this asserts the output differs from the input.
check(state.agents.map(a => a.pubkey).join() !== ordered.map(a => a.pubkey).join(),
  'NEGATIVE CONTROL — the output order differs from the input order, so the sort is not a pass-through')

// NEGATIVE CONTROL — and the filter can reject. A validator that accepts everything would also
// produce "nothing dropped" above.
const dirty = rosterAgents({ agents: [{ pubkey: A, status: 'admitted' }, { pubkey: 'nope', status: 'admitted' }] })
check(dirty.length === 1, `NEGATIVE CONTROL — a malformed row IS dropped (kept ${dirty.length} of 2)`)
check(rosterAgents({}).length === 0 && rosterAgents({ agents: 'not an array' }).length === 0,
  'a state with no agents field yields an empty roster rather than throwing')

// ---- 3. what the operator reads -----------------------------------------------------------------
const npubB = nip19.npubEncode(B)
check(shortNpub(B).startsWith(npubB.slice(0, 12)) && shortNpub(B).endsWith(npubB.slice(-6)),
  'the short form keeps both ends of the npub, so two roster entries can be told apart')
check(shortNpub(B).includes('…') && shortNpub(B).length < npubB.length, 'and it is visibly elided, not truncated silently')

const admitted = agentOptionText({ pubkey: B, status: 'admitted', label: 'My Dude' })
const paused = agentOptionText({ pubkey: A, status: 'paused', label: 'Sleepy' })
const revoked = agentOptionText({ pubkey: C, status: 'revoked', label: 'Gone' })
check(admitted.startsWith('My Dude — '), `an admitted agent reads as its name (${admitted})`)
check(!/paused|removed|admitted|in$/.test(admitted), 'an admitted agent carries no status noise — every row would say the same thing')
check(paused.endsWith(' — paused'), `a paused agent says so in the row (${paused})`)
check(revoked.endsWith(' — removed'), `a revoked agent reads as removed, not as its wire word (${revoked})`)
check(agentOptionText({ pubkey: A, status: 'admitted', label: null }).startsWith('unnamed agent — '),
  'a key with no label still renders, because an unnamed agent is a real roster row')
check(statusLabel('something-new') === 'something-new',
  'a status this console has never heard of renders raw — it must LOOK unfamiliar, not borrow a friendly word')

// ---- 4. the picker is fed by the state freshBridge already verified ------------------------------
const routes = readFileSync(join(CONSOLE, 'task-routes.mjs'), 'utf8')
if (routes.length < 3000) inconclusive(`task-routes.mjs read back only ${routes.length} bytes`)
check(/return \{ bridge, state \}/.test(routes),
  'freshBridge returns the state it parsed, so the picker costs no second fetch and no second trust assumption')
check(!/new WebSocket/.test(routes.slice(routes.indexOf('async function loadRoster'))) ||
      routes.indexOf('async function loadRoster') < 0,
  'loadRoster opens no socket of its own')
check(/await freshBridge\(\)/.test(routes.slice(routes.indexOf('async function loadRoster'), routes.indexOf('async function manage'))),
  'loadRoster goes through freshBridge, so the signature and freshness checks are not bypassed')

// The free-text field stays the value `manage()` reads. If the picker became the source, a key that
// is not on the roster yet — a real case the issue names — would be unreachable.
const manage = routes.slice(routes.indexOf('async function manage'))
check(/hex\(\$\('route-participant'\)\.value\)/.test(manage),
  'manage() still reads the free-text participant field, so an off-roster key is not a second code path')
check(/\$\('route-participant'\)\.value = event\.target\.value/.test(routes),
  'and the picker writes INTO that field rather than replacing it')

// The mention must not be locked to the picker: a label is printable ASCII, a Buzz display_name
// since #404 is not, so the label is a guess and anything the operator typed is an answer.
check(/if \(!\$\('route-mention'\)\.value\.trim\(\)/.test(routes),
  'the mention is only suggested when empty — a typed handle is never overwritten by a label')

// ---- 5. one owner for the status vocabulary -----------------------------------------------------
const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { walk(full); continue }
    if (/\.(mjs|html|js)$/.test(entry)) files.push(full)
  }
}
walk(CONSOLE)
if (files.length < 20) inconclusive(`the console scan found only ${files.length} source files`)
const offenders = files
  .filter(f => !f.endsWith('agent-roster.mjs'))
  .filter(f => /const STATUS_LABEL\b|const STATUSES\b/.test(readFileSync(f, 'utf8')))
  .map(f => f.slice(CONSOLE.length + 1))
check(offenders.length === 0,
  `only agent-roster.mjs declares the status vocabulary (${files.length} sources scanned` +
  `${offenders.length ? `; offenders: ${offenders.join(', ')}` : ''})`)
check(/const STATUS_LABEL\b/.test(readFileSync(join(CONSOLE, 'agent-roster.mjs'), 'utf8')),
  'NEGATIVE CONTROL — the same scan DOES find the declaration inside the module that owns it')
check(readFileSync(join(CONSOLE, 'agents.html'), 'utf8').includes("from './agent-roster.mjs'"),
  'the agents page consumes the shared vocabulary rather than keeping its own copy')

// The wire values are a protocol surface, not copy. Pin them so a rename has to argue with a test.
check(STATUSES.join(',') === 'admitted,paused,revoked', `the wire statuses are unchanged (${STATUSES.join(',')})`)
check(STATUS_LABEL.revoked === 'removed', 'and `revoked` still reads as removed, not as something reassuring')

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
