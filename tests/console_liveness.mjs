// console_liveness — what has been OBSERVED about an agent, from the console (#497, S6 of #486).
//
// `connect-agent --check` runs on the agent's machine and cannot see four of its own rows; #492 is
// the change that makes it say so rather than exit 3 forever and let that read as a local fault.
// This panel is the other side. The property under test is the same one, pointed the other way:
// nothing here may collapse "nobody looked" into "not there", or "claimed" into "observed".
//
// THE FAILURE THIS EXISTS TO PREVENT is not a wrong colour on a row. It is an operator publishing a
// SECOND kind:0 for a key that already has one, because four sockets timed out and the panel said
// the name was missing. A second profile is not a harmless no-op — it is a second face for one key,
// and the newer one wins wherever it is seen first.
//
// Both directions on every guard: each refusal is paired with a case that still gets through.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as live from '../console/agent-liveness.mjs'
import { PRESENT, UNVERIFIED, MISSING, UNKNOWN } from '../src/agent_install_state.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nconsole_liveness\n')

const PUB = 'a'.repeat(64)
const kind0 = (content, created_at = 100) => ({ kind: 0, pubkey: PUB, created_at, content: JSON.stringify(content) })
const readOf = (events, { answered = 4, asked = 4 } = {}) => ({ events, answered, asked })

// ------------------------------------------------------------------------------------------
console.log('1. one vocabulary, not two')
// A second translation of these four words is how a state that means "nobody looked" acquires a
// friendly synonym on one surface. The page cannot import ../src/, so the twin is held here.
check(live.PRESENT === PRESENT && live.UNVERIFIED === UNVERIFIED && live.MISSING === MISSING && live.UNKNOWN === UNKNOWN,
  'the console states are the same four strings src/agent_install_state.mjs uses')
check(live.STATES.join(',') === [PRESENT, UNVERIFIED, MISSING, UNKNOWN].join(','), 'and in the same order, so a renderer keyed on index cannot drift')
check(Object.keys(live.MARK).sort().join(',') === live.STATES.slice().sort().join(','), 'every state has a mark — an unmarked state renders blank and reads as fine')
check(live.MARK[UNVERIFIED] !== live.MARK[PRESENT] && live.MARK[UNKNOWN] !== live.MARK[MISSING],
  'and unverified never prints as a tick, nor unknown as a cross — the two collapses this panel exists to prevent')

// ------------------------------------------------------------------------------------------
console.log('\n2. the name, which is the only row this surface can PROVE')
{
  const r = live.nameRow({ read: null, agent: { label: 'Pi' } })
  check(r.state === UNKNOWN, 'nobody has read yet — UNKNOWN, not missing')
}
{
  // The case that costs the most to get wrong. Four sockets timed out; the key may well have a name.
  const r = live.nameRow({ read: readOf([], { answered: 0, asked: 4 }), agent: {} })
  check(r.state === UNKNOWN, 'no relay ANSWERED — still UNKNOWN, however empty the result looks')
  check(/cannot tell an unreachable relay/.test(r.note),
    '  …and says why, because the next action is to retry rather than to publish a second profile')
}
{
  const r = live.nameRow({ read: readOf([]), agent: {} })
  check(r.state === MISSING, 'relays answered and served no kind:0 — a real negative')
  check(/no published name/.test(r.note), '  …and reads as a name to publish, not as a relay to chase')
}
{
  const r = live.nameRow({ read: readOf([kind0({ about: 'no name here' })]), agent: {} })
  check(r.state === MISSING, 'a kind:0 with no name is MISSING — a users row with no display_name resolves to nothing')
  check(/looks like it worked|resolves to nothing/.test(r.note), '  …and says so, because publishing it looked like success')
}
{
  // POSITIVE CONTROL — the guard is not refusing everything.
  const r = live.nameRow({ read: readOf([kind0({ name: 'Pi Agent' })]), agent: { label: 'Pi Agent' } })
  check(r.state === PRESENT && r.name === 'Pi Agent', 'an ordinary published name reads back PRESENT (POSITIVE CONTROL)')
  check(/read back cold/.test(r.note), '  …and the note says it was read back cold, not that a relay said OK')
}
{
  const r = live.nameRow({ read: readOf([kind0({ name: 'old' }, 10), kind0({ name: 'current' }, 99)]), agent: {} })
  check(r.name === 'current', 'the NEWEST profile decides the name — an older one still served is not the answer')
}
{
  const r = live.nameRow({ read: readOf([kind0({ name: 'ignored', display_name: 'Pi Agent' })]), agent: {} })
  check(r.name === 'Pi Agent', 'display_name wins over name — Buzz resolves the at-word against display_name')
}
{
  // The trap this row is worth having. The label is owner-set and local; the at-word must match the
  // PUBLISHED name, so an operator typing what the console showed them addresses nobody.
  const r = live.nameRow({ read: readOf([kind0({ display_name: 'Pi Agent' })]), agent: { label: 'pi-box' } })
  check(r.state === PRESENT && /roster label/.test(r.note),
    'a label that differs from the published name is called out — the at-word has to match the published one')
  check(!/roster label/.test(live.nameRow({ read: readOf([kind0({ display_name: 'Pi' })]), agent: { label: 'Pi' } }).note),
    'BOTH DIRECTIONS — and a label that agrees does not raise it, so the warning means something')
}
{
  const r = live.nameRow({ read: readOf([{ kind: 0, pubkey: PUB, created_at: 1, content: 'not json' }]), agent: {} })
  check(r.state === MISSING, 'an unparseable profile is a name that does not resolve, reported rather than thrown')
}

// ------------------------------------------------------------------------------------------
console.log('\n3. the roster status is CLAIMED, whatever colour it is')
check(live.rosterRow({ agent: { status: 'admitted' } }).state === UNVERIFIED,
  'admitted is UNVERIFIED — the bridge enforces on the grant set, and neither predicts the other')
check(/grant set/.test(live.rosterRow({ agent: { status: 'admitted' } }).note), '  …and the note says what actually decides the door')
check(live.rosterRow({ agent: { status: 'revoked' } }).state === MISSING, 'revoked is a real negative')
check(live.rosterRow({ agent: { status: 'paused' } }).state === MISSING, 'so is paused — it cannot act')
check(live.rosterRow({ agent: null }).state === UNKNOWN, 'and no roster entry at all is UNKNOWN, not removed')

// ------------------------------------------------------------------------------------------
console.log('\n4. the report, and the ceiling')
{
  const r = live.livenessReport({ agent: { label: 'Pi', status: 'admitted' }, profileRead: readOf([kind0({ name: 'Pi' })]) })
  check(r.rows.length === live.LIVENESS_ROWS.length, 'every row is reported — a row nobody asked about must not vanish')
  check(r.nameProven === true, 'the name is proven')
  check(!('ok' in r) && !('complete' in r),
    'and there is NO overall pass flag — the only row this surface proves is the name, and a boolean would be read as "the agent works"')
  const unobservable = r.rows.filter(x => x.state === UNKNOWN).map(x => x.key)
  check(unobservable.length === 3 && unobservable.every(k => k in live.NOT_OBSERVABLE_HERE),
    'the three rows no browser can see are UNKNOWN, and each is declared')
  check(r.rows.filter(x => x.state === UNKNOWN).every(x => /settled/.test(x.note)),
    '  …and each names where it IS settled, so the operator does not hunt on this machine')
  check(r.atCeiling === true && /settled off this page/.test(r.headline),
    'with nothing negative outstanding the report says this is the best it can show, rather than leaving three dashes to read as faults')
}
{
  // BOTH DIRECTIONS — the ceiling sentence must not be permanent furniture.
  const r = live.livenessReport({ agent: { status: 'revoked' }, profileRead: readOf([kind0({ name: 'Pi' })]) })
  check(r.atCeiling === false && !/settled off this page/.test(r.headline),
    'BOTH DIRECTIONS — one negative row drops the ceiling sentence entirely')
  check(r.counts.missing === 1, '  …and it is counted, not folded into the unknowns')
}
{
  const r = live.livenessReport({ agent: { status: 'admitted' }, profileRead: readOf([]) })
  check(r.nameProven === false && /no published name/.test(r.headline),
    'a key with no name leads with that — it is what makes every other row moot')
}
{
  const r = live.livenessReport({ agent: { status: 'admitted' }, profileRead: null })
  check(r.nameProven === false && /not the same as nothing being wrong/.test(r.headline),
    'and a panel nobody has run yet says exactly that, rather than showing a clean row of dashes')
  check(r.counts.missing === 0, '  …with nothing marked missing, because nothing was looked at')
}

// ------------------------------------------------------------------------------------------
console.log('\n5. the page wires it')
const page = readFileSync(join(ROOT, 'console', 'agents.html'), 'utf8')
const pageCode = page.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '')
check(/from '\.\/agent-liveness\.mjs'/.test(pageCode), 'agents.html imports the report rather than judging rows inline')
check(/readPublic/.test(pageCode) && /from '\.\/profile-publish\.mjs'/.test(pageCode),
  'and reads the profile through the module that already does it, rather than opening a second socket path')
check(/livenessReport\(/.test(pageCode), 'and renders the report it returns')
// A read that THREW is a read that did not happen. The module cannot tell the difference — it is
// handed whatever the page passes — so the one place this can go wrong is the page's own catch,
// and a fabricated empty result there renders MISSING for a key that has a name. That is the
// second-profile failure this suite exists for, and it survived until it was asserted here.
const caught = /catch\s*\{\s*read = ([^}]+)\}/.exec(pageCode)
check(caught && caught[1].trim() === 'null',
  'and a failed read stays null rather than becoming an empty result — an exception is not an answer')
check(/profileRead: read\b/.test(pageCode), 'and the report is built from that read, not from a value the page invented')
check(!/textContent = .{0,40}(working|all good|healthy)/i.test(pageCode),
  'and no branch prints a summary word this page has not observed')
// The stylesheet can undo in one line what the module is careful about: four states sharing two
// colours puts "nobody looked" and "it is not there" back in the same cell.
const colours = live.STATES.map(state => (new RegExp(`\\.mark\\.${state}\\{color:([^}]+)\\}`).exec(page) || [])[1])
check(colours.every(Boolean), 'every state has its own .mark colour in the stylesheet')
check(new Set(colours).size === colours.length, '  …and no two states share one, so the glyphs are not the only thing telling them apart')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
