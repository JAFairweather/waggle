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
// since #404 is not, so the label is a guess and anything the operator typed is an answer. WHICH
// rule enforces that is asserted behaviourally in §6 — this file first pinned the string
// `if (!$('route-mention').value.trim()`, and that string was the BUG: suggest-when-empty and
// suggest-unless-typed agree only on the first pick.
check(/picked\.mention/.test(routes), 'the picker records what it suggested, so it can tell its own guess from an answer')

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

// ---- 6. the panel driven for real, against a fake DOM and an in-memory relay (#440) --------------
//
// Sections 1–5 read the source. That is enough for structure and vocabulary, and it was NOT enough
// for behaviour: §4 pinned a string that encoded the wrong rule, and passed. Everything below drives
// the real module's real handlers, so a rule change has to survive the operator's sequence rather
// than a regex. No sockets — the WebSocket global is a local object that answers from an array.

const { finalizeEvent, generateSecretKey, getPublicKey } = await import('nostr-tools/pure')

const nodes = new Map()
function node(id = '') {
  const n = {
    id, value: '', className: '', children: [], selectedOptions: [], listeners: {}, _text: '',
    appendChild(child) { n.children.push(child); return child },
    addEventListener(type, fn) { (n.listeners[type] ||= []).push(fn) },
    before() {},
    fire(type) { for (const fn of n.listeners[type] || []) fn({ target: n }) },
  }
  Object.defineProperty(n, 'textContent', {
    get: () => n._text,
    set: (v) => { n._text = String(v); if (n._text === '') n.children.length = 0 },
  })
  // The panel's markup is where the fields come from, so parsing ids out of it is what makes
  // $('route-participant') resolve — the same order the browser does it in.
  Object.defineProperty(n, 'innerHTML', {
    get: () => '',
    set: (html) => { for (const m of String(html).matchAll(/id="([a-z0-9-]+)"/g)) el(m[1]) },
  })
  return n
}
const el = (id) => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id) }
el('bridge')   // pre-existing on the page; the panel's markup does not declare it

let served = []
class FakeSocket {
  constructor() { setTimeout(() => this.onopen && this.onopen(), 0) }
  send(raw) {
    const frame = JSON.parse(raw)
    if (frame[0] !== 'REQ') return
    // Every state is served to every REQ, filters ignored on purpose: the module re-checks the
    // author itself, and a relay that answers with somebody else's event is a thing that happens.
    for (const event of served) this.onmessage({ data: JSON.stringify(['EVENT', frame[1], event]) })
    this.onmessage({ data: JSON.stringify(['EOSE', frame[1]]) })
  }
  close() {}
}
globalThis.WebSocket = FakeSocket
globalThis.document = {
  getElementById: el,
  createElement: () => node(),
  querySelector: () => node(),
}
globalThis.confirm = () => false

const secretOne = generateSecretKey(), secretTwo = generateSecretKey()
const BRIDGE_ONE = getPublicKey(secretOne), BRIDGE_TWO = getPublicKey(secretTwo)
const AGENT_A = key('12'), AGENT_B = key('34'), AGENT_C = key('56')
const controlState = (secret, bridge, agents) => finalizeEvent({
  kind: 30078,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', 'waggle-control-state']],
  content: JSON.stringify({ v: 1, bridge, observed_at: Math.floor(Date.now() / 1000), agents }),
}, secret)
served = [
  controlState(secretOne, BRIDGE_ONE, [
    { pubkey: AGENT_A, status: 'admitted', label: 'My Dude' },
    { pubkey: AGENT_B, status: 'admitted', label: 'Dennis' },
  ]),
  controlState(secretTwo, BRIDGE_TWO, [{ pubkey: AGENT_C, status: 'admitted', label: 'Kerouac' }]),
]

await import('../console/task-routes.mjs')

const field = (id) => el(id).value
const status = () => el('routest').textContent
const setBridge = (value, fireEvent) => { el('bridge').value = value; if (fireEvent) el('bridge').fire('input') }
async function loadRoster() { await el('route-roster').onclick(); }
function choose(selectId, optionIndex) {
  const select = el(selectId)
  const option = select.children[optionIndex]
  if (!option) inconclusive(`${selectId} has no option at index ${optionIndex} — the roster never loaded`)
  select.value = option.value
  select.selectedOptions = [option]
  select.onchange({ target: select })
}

setBridge(BRIDGE_ONE)
await loadRoster()
check(el('route-participant-pick').children.length === 3,
  `the roster loaded through the real handler (${el('route-participant-pick').children.length - 1} agent(s) offered)`)
if (el('route-participant-pick').children.length !== 3) inconclusive('the picker never filled, so nothing below is exercised')

// -- the change of mind. This is the bug: the second pick used to leave the FIRST label behind.
choose('route-participant-pick', 1)
const firstPick = { participant: field('route-participant'), mention: field('route-mention') }
check(firstPick.participant === AGENT_B && firstPick.mention === 'Dennis',
  `picking suggests the agent's label (${firstPick.mention}) alongside its key`)
choose('route-participant-pick', 2)
check(field('route-participant') === AGENT_A, 'changing the pick updates the key')
check(field('route-mention') === 'My Dude',
  `and the mention follows it (${field('route-mention')}) — a suggestion left behind names one agent and wakes another`)

// -- and the other direction, which is the property #404 put there: a TYPED handle is an answer.
el('route-mention').value = 'My Dude With A Space'
choose('route-participant-pick', 1)
check(field('route-participant') === AGENT_B, 'a typed mention does not stop the key from updating')
check(field('route-mention') === 'My Dude With A Space',
  `a handle the operator typed survives a later pick (${field('route-mention')})`)

// -- editing the bridge field clears what the picker put there, and only that.
el('route-mention').value = ''
choose('route-participant-pick', 1)
setBridge(BRIDGE_TWO, true)
check(field('route-participant') === '' && field('route-mention') === '',
  'editing the bridge field clears the key and label the picker wrote')
check(el('route-participant-pick').children.length === 1,
  'and empties the list, so the select stops showing an agent from the previous bridge')

// NEGATIVE CONTROL — by provenance, not a blanket wipe. The same sequence, except the operator
// overrules the picked key by hand before the bridge moves. Written the long way on purpose: an
// earlier draft pasted the key when nothing had been picked, so the clearing branch was never
// reached and a mutation that wiped the field unconditionally still passed.
setBridge(BRIDGE_ONE, true)
await loadRoster()
choose('route-participant-pick', 1)
el('route-participant').value = AGENT_C          // typed over the pick — an answer, not our guess
setBridge(BRIDGE_TWO, true)
check(field('route-participant') === AGENT_C,
  `NEGATIVE CONTROL — a key typed over the pick survives the bridge change (${field('route-participant').slice(0, 8)}…)`)
check(field('route-mention') === '',
  'while the label the picker did write, in the same sequence, is still cleared')

// -- the guard. `routing.mjs` writes the bridge field programmatically, which fires no event, so
//    the clearing above cannot be the protection. manage() has to refuse.
el('route-participant').value = ''
setBridge(BRIDGE_ONE, true)
await loadRoster()
choose('route-participant-pick', 1)
el('route-channel').value = 'a8186b53-1111-2222-3333-444455556666'
setBridge(BRIDGE_TWO, false)                     // moved underneath the panel, no event
await el('route-add').onclick()
check(/loaded for a different bridge/.test(status()),
  `manage() refuses a pick made against another bridge, and says why (${status()})`)
check(el('route-participant-pick').children.length > 1,
  'NEGATIVE CONTROL — it refused with the stale roster still loaded, so the refusal is the guard and not a side effect of clearing')

// Both directions, and the reason is what separates them: put the bridge back and the SAME call
// gets past the guard, failing later on an empty participant instead. A guard that refuses
// everything is indistinguishable from one that refuses the dangerous thing.
setBridge(BRIDGE_ONE, false)
el('route-participant').value = ''
await el('route-add').onclick()
check(!/loaded for a different bridge/.test(status()) && /npub or 64-character hex/.test(status()),
  `with the roster's own bridge the guard stands aside (${status()})`)

// And the free-text path §4 pins: no roster loaded, any bridge, nothing refuses on this ground.
setBridge(BRIDGE_ONE, true)                      // clears the roster
setBridge(BRIDGE_TWO, false)
el('route-participant').value = AGENT_C
el('route-mention').value = ''                   // so it stops on the mention grammar, not the signer
await el('route-add').onclick()
check(!/loaded for a different bridge/.test(status()),
  `a key pasted with no roster loaded is never refused for a bridge mismatch (${status()})`)

console.log(`\n${pass ? 'ALL PASS' : 'FAILURES ABOVE'}`)
process.exit(pass ? 0 : 1)
