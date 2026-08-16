// console_first_prompt — the console's last step hands over a prompt, not a command (#490).
//
// The connect flow used to end by rendering `node tools/connect-agent.mjs --name … --pubkey …`:
// a command for the operator to go and run somewhere else. What the flow has to end with is the
// text they paste into the new session — the agent's own first prompt.
//
// That creates a duplication this suite exists to make safe. The prompt is built in the browser;
// the same body is written to disk by `tools/connect-agent.mjs --startup` in node. They cannot be
// one file: `tools/serve-console.mjs` pins `DOCROOT = console/` and refuses anything above it
// (`serve-console.mjs:72`), so the page cannot import `../src/`; and `console/` is absent from the
// deploy ship list (`deploy-runner.sh:63`), so shipped code cannot import the page's copy either.
// Both directions are closed on purpose, which leaves two copies and one obligation: PROVE they
// agree. `console/scope-hash.mjs` lives under the same bind.
//
// Byte-identical, not equivalent. If the paste and the on-disk file drift, the agent is handed two
// different accounts of itself — one at connect time and one every session after — and the pair
// that disagrees is the pair nobody re-reads.
//
// Both directions on every guard, per the house rule. The refusal path is checked for its MESSAGE
// as well as its firing, because `!ok` cannot tell a correct refusal from a correct refusal with a
// misleading reason, and the operator acts on the reason.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as nodeState from '../src/agent_install_state.mjs'
import * as node from '../src/agent_startup.mjs'
import * as web from '../console/agent-startup.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const check = (cond, what) => { if (cond) { pass++; console.log(`  ok   ${what}`) } else { fail++; console.log(`  FAIL ${what}`) } }

console.log('\nconsole_first_prompt\n')

const { PRESENT, UNVERIFIED, MISSING, UNKNOWN } = nodeState
const PUB = 'a'.repeat(64)
const CHAN = 'c'.repeat(64)

// ------------------------------------------------------------------------------------------
console.log('1. the four state constants, which the twin inlines rather than imports')
// The twin cannot import `agent_install_state.mjs` — it carries `installState()` and the whole
// ARTIFACTS table, none of which a browser needs. So it re-declares the four strings, and a drift
// here would not throw: it would silently make every row in the pasted prompt render as its raw
// state name while the on-disk file rendered the sentence. Cheap to check, invisible if it breaks.
const web_src = readFileSync(join(ROOT, 'console/agent-startup.mjs'), 'utf8')
for (const [name, value] of [['PRESENT', PRESENT], ['UNVERIFIED', UNVERIFIED], ['MISSING', MISSING], ['UNKNOWN', UNKNOWN]]) {
  check(web_src.includes(`const ${name} = '${value}'`),
    `${name} is '${value}' in the twin, the same value src/agent_install_state.mjs exports`)
}
check(!web_src.includes("from './agent_install_state.mjs'"),
  'and the twin does not import it — that path does not resolve under DOCROOT=console/')

// ------------------------------------------------------------------------------------------
console.log('\n2. the secret sweep agrees, in both directions')
// Ahead of the documents, deliberately: `startupDoc` THROWS when the sweep fires, so a sweep that
// flags everything takes the suite down before an assertion runs — and a suite that dies reports
// zero failures, which reads exactly like one that passed.
const SWEEP = [
  ['read docs/AGENT_BRIEF.md and post as yourself', null, 'ordinary prose'],
  [`your key is ${PUB}`, null, 'a 64-hex PUBLIC key'],
  ['bunker://abc?relay=wss://x', 'a bunker:// pairing URI', 'a bunker URI'],
  ['nostrconnect://a1?relay=wss://r&secret=dead', 'a nostrconnect:// pairing URI', 'a nostrconnect URI'],
  ['nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'an nsec', 'an nsec'],
  ['-----BEGIN OPENSSH PRIVATE KEY-----', 'a private key block', 'a private key block'],
  ['the host is 192.168.1.24 today', 'an IPv4 address', 'an IPv4 address'],
  ['version 24.18.0 of node', null, 'a version string that is not a dotted quad'],
]
for (const [text, expected, what] of SWEEP) {
  const a = node.secretInText(text), b = web.secretInText(text)
  check(a === b, `both copies agree on ${what} — ${a === null ? 'clean' : a}`)
  check(a === expected, `and both are right about it${expected === null ? ' (NEGATIVE CONTROL — not flagged)' : ''}`)
}

// ------------------------------------------------------------------------------------------
console.log('\n3. byte-identical bodies, over a matrix of install reports')
// Not one happy fixture. The document BRANCHES on report state — the "not confirmed" paragraph,
// the "every artifact above is confirmed" paragraph, and the no-state case are three different
// tails, and a twin could agree on one and drift on another. Every branch is walked.
const rows = states => Object.entries(states).map(([key, state]) =>
  ({ key, title: key, state, note: state === MISSING ? 'nobody has published it' : '' }))

const MATRIX = [
  ['every row PRESENT — the "all confirmed" tail', { report: { rows: rows({
    'bunker-uri': PRESENT, 'bunker-client': PRESENT, 'signer-identity': PRESENT, 'dm-relays': PRESENT,
    'admit-grant': PRESENT, 'mcp-registration': PRESENT, 'mcp-exclusive': PRESENT,
    'mcp-identity': PRESENT, profile: PRESENT }) } }],
  ['a mixed report — the "N are not confirmed" tail', { report: { rows: rows({
    'bunker-uri': PRESENT, 'bunker-client': UNVERIFIED, 'signer-identity': UNKNOWN,
    'dm-relays': MISSING, 'admit-grant': PRESENT, profile: MISSING }) } }],
  ['exactly one open row — the singular "is", not "are"', { report: { rows: rows({
    'bunker-uri': PRESENT, 'admit-grant': MISSING }) } }],
  // The console's own shape: it can observe exactly one row and never the other eight. This is the
  // report the page renders on EVERY connect, so it is the one the two copies most need to agree on.
  ['the console shape — one observed row, eight never checked', { report: { rows: rows({
    'bunker-uri': UNKNOWN, 'bunker-client': UNKNOWN, 'signer-identity': UNKNOWN, 'dm-relays': UNKNOWN,
    'admit-grant': PRESENT, 'mcp-registration': UNKNOWN, 'mcp-exclusive': UNKNOWN,
    'mcp-identity': UNKNOWN, profile: UNKNOWN }) } }],
  ['every row UNKNOWN — nothing observed at all', { report: { rows: rows({
    'bunker-uri': UNKNOWN, 'admit-grant': UNKNOWN, profile: UNKNOWN }) } }],
  ['no report at all — the "nothing here is confirmed" tail', {}],
  ['an empty rows array — the case that satisfies BOTH filters', { report: { rows: [] } }],
  ['no runtime label, no channel, no pubkey', { report: { rows: rows({ 'admit-grant': PRESENT }) } }],
  // Every non-default parameter at once. Two mutations survived the first battery — a twin that
  // ignored `briefPath`, and one with the `!agent` guard removed — and both survived for the same
  // reason: no fixture passed the parameter, so no assertion could see it drop. This closes the
  // class rather than those two instances. `writtenBy` is the third defect of this shape.
  ['every non-default parameter supplied at once', { briefPath: 'docs/OTHER_BRIEF.md',
    writtenBy: 'a fixture, deliberately,', report: { rows: rows({ 'admit-grant': PRESENT }) } }],
  // `report.lane` renders the `--lane` flag on the remedy command (#515). It is a field on `report`
  // rather than a parameter, so nothing above walks it, and the two copies inline their own lane
  // list — the exact shape that drifts. All three branches, because a twin can agree on one.
  ['a BROKER-lane report — the remedy names the other lane', { report: { lane: 'broker',
    rows: rows({ 'bunker-uri': MISSING, profile: UNKNOWN }) } }],
  ['a SEALED-lane report', { report: { lane: 'sealed', rows: rows({ 'bunker-uri': MISSING, profile: UNKNOWN }) } }],
  ['an unrecognised lane — dropped, not echoed', { report: { lane: 'brokr',
    rows: rows({ 'bunker-uri': MISSING, profile: UNKNOWN }) } }],
]

for (const [what, extra] of MATRIX) {
  const args = {
    agent: 'pi-agent', pubkey: PUB, channel: CHAN,
    runtimeLabel: 'Any other MCP host (Raspberry Pi, headless, self-hosted)', ...extra,
  }
  if (what.startsWith('no runtime label')) { delete args.runtimeLabel; delete args.channel; delete args.pubkey }
  const a = node.startupDoc(args), b = web.startupDoc(args)
  check(a === b, `${what} — the two copies render the same ${a.length} bytes`)
}

// Byte-identity is blind to a parameter BOTH copies ignore — two twins that dropped `briefPath`
// agree perfectly. So each non-default parameter is also asserted to reach the output, in both
// directions: the value appears, and the default it replaced does not.
// The lane is the same blindness one layer in: two copies that both ignored `report.lane` agree
// byte for byte. Each is asserted to render it, and to render the other branches differently — a
// copy that hardcoded one lane passes the identity check and fails here.
for (const [label, copy] of [['node', node], ['browser', web]]) {
  const remedy = lane => (copy.startupDoc({ agent: 'pi-agent', pubkey: PUB,
    report: { lane, rows: rows({ 'bunker-uri': MISSING, profile: UNKNOWN }) } })
    .split('\n').filter(l => l.includes('connect-agent.mjs') && l.includes('--check')))
  const broker = remedy('broker')
  check(broker.length >= 2 && broker.every(l => l.includes('--lane broker')),
    `${label}: a broker-lane report renders --lane broker in every remedy line`)
  check(remedy('sealed').every(l => l.includes('--lane sealed')),
    `${label}:   …and BOTH DIRECTIONS, a sealed-lane report renders --lane sealed`)
  check(remedy(null).every(l => !l.includes('--lane')) && remedy('brokr').every(l => !l.includes('--lane')),
    `${label}:   …and neither an undeclared nor an unrecognised lane prints a flag`)
}
// BOTH DIRECTIONS on the name predicate, across the twin. The fixtures above use `pi-agent`, an id
// the tool accepts; the console's `agent-name` field is free text, so a DISPLAY name reaches this
// renderer in production and it must withhold the command rather than print one that exits 1 — the
// failure an operator who typed `Pi Dog` actually hit (#523 review). Both copies, because a browser
// copy that kept the old quoting would render a failing command to the only producer that can.
for (const [label, copy] of [['node', node], ['browser', web]]) {
  const doc = copy.startupDoc({ agent: 'Pi Dog', pubkey: PUB,
    report: { lane: 'sealed', rows: rows({ 'bunker-uri': MISSING, profile: UNKNOWN }) } })
  check(!/--name\s/.test(doc), `${label}: a DISPLAY name renders no --name argument at all`)
  check(doc.includes('Pi Dog') && /Settle the agent's id first/.test(doc),
    `${label}:   …and names the offending name and the rule instead`)
  check(/Neither command works yet/.test(doc) && /never checked/.test(doc),
    `${label}:   NEGATIVE CONTROL — it withholds the command, not the surrounding warning`)
}

// The lane names themselves, pinned. A stale list in the browser copy does not render a wrong
// sentence — it drops a valid `--lane` flag, or prints one `installState` would refuse.
check(Object.keys(web.LANES).sort().join(',') === Object.keys(nodeState.LANES).sort().join(','),
  'the browser copy knows exactly the lanes `src/agent_install_state.mjs` does')

for (const copy of [['node', node], ['browser', web]]) {
  const [label, mod] = copy
  const doc = mod.startupDoc({ agent: 'pi-agent', briefPath: 'docs/OTHER_BRIEF.md', report: { rows: [] } })
  check(doc.includes('docs/OTHER_BRIEF.md') && !doc.includes('docs/AGENT_BRIEF.md'),
    `the ${label} copy renders the briefPath it was GIVEN, and drops the default it replaced`)
  let threw = null
  try { mod.startupDoc({ report: { rows: [] } }) } catch (e) { threw = e.message }
  check(threw !== null, `  …and the ${label} copy refuses to render a document with no agent name`)
}

// A property the byte-comparison alone cannot state: that the comparison is comparing something.
// Two functions that both returned '' would pass every assertion above.
const sample = node.startupDoc({ agent: 'pi-agent', pubkey: PUB, report: { rows: rows({ 'admit-grant': PRESENT }) } })
check(sample.length > 1500 && sample.includes('# pi-agent — you are a participant'),
  `SIZE FLOOR — the rendered body is real (${sample.length} bytes, headed by the agent's name)`)
check(sample.includes('You do not get read'),
  'and carries the wall paragraph, the one claim an agent most often reports as a defect')

// The names differ between copies, so a stale twin cannot pass by echoing a constant.
const other = web.startupDoc({ agent: 'second-agent', pubkey: 'b'.repeat(64), report: { rows: [] } })
check(other.includes('# second-agent —') && !other.includes('pi-agent'),
  'the twin renders the name it was given, not a baked-in one')

// ------------------------------------------------------------------------------------------
console.log('\n4. NEGATIVE CONTROL — a report carrying a credential refuses, identically')
// #490 asks for a control that FIRES. A `bunker://` reaches the document through a row NOTE, which
// is machine-generated text from a tool this file does not control — the exact path the sweep was
// put there to cover.
const poisoned = { agent: 'pi-agent', pubkey: PUB, report: { rows: [
  { key: 'bunker-uri', title: 'bunker-uri', state: MISSING, note: 'try bunker://deadbeef?relay=wss://r' },
] } }
let nodeErr = null, webErr = null
try { node.startupDoc(poisoned) } catch (e) { nodeErr = e.message }
try { web.startupDoc(poisoned) } catch (e) { webErr = e.message }
check(nodeErr !== null, 'the node copy REFUSES to render rather than rendering the pairing URI')
check(webErr !== null, 'and so does the browser copy — the paste is held to the same rule as the file')
check(nodeErr === webErr, `and the reason matches word for word — "${nodeErr}"`)
check(String(nodeErr).includes('a bunker:// pairing URI'),
  'and names the shape that matched, so the operator knows what to go and remove')

// The bound, stated rather than implied. `src/agent_startup.mjs` says this in its header; a suite
// that left it out would read as if the sweep were a guarantee of "nothing secret".
const rawKeyRow = { agent: 'pi-agent', pubkey: PUB, report: { rows: [
  { key: 'admit-grant', title: 'admit-grant', state: MISSING, note: `seeded from ${'f'.repeat(64)}` },
] } }
const rendered = web.startupDoc(rawKeyRow)
check(rendered.includes('f'.repeat(64)),
  'BOUND — a raw 64-hex PRIVATE key passes the sweep and reaches the document, as the header says')
check(node.startupDoc(rawKeyRow) === rendered,
  'and the two copies agree on that too — the twin does not quietly hold a different bound')

// ------------------------------------------------------------------------------------------
console.log('\n5. provenance — the document says who actually wrote it')
// The line is a claim about where the document came from, inside a document whose second rule is
// that nothing unproven is stated as fact. `--startup` writes one; the console pastes one; each
// has to name itself, because the agent's first instinct on reading "regenerate it" is to run the
// named command, and the wrong name sends it to a machine nothing observed.
const provenance = args => node.startupDoc({ agent: 'pi-agent', report: { rows: [] }, ...args }).split('\n')[2]
check(provenance({}) === "Written by `tools/connect-agent.mjs --startup` from this agent's own install state.",
  'the DEFAULT is unchanged — the tool\'s output is byte-for-byte what it was before #490')
check(provenance({ writtenBy: 'the waggle console, at connect time,' })
    === "Written by the waggle console, at connect time, from this agent's own install state.",
  'and an override reads as a sentence, not as a slot with a command dropped into it')
check(provenance({ writtenBy: 'X' }) === web.startupDoc({ agent: 'pi-agent', report: { rows: [] }, writtenBy: 'X' }).split('\n')[2],
  'both copies carry the override — the twin did not keep the old hard-coded line')

// ------------------------------------------------------------------------------------------
console.log('\n6. the flow ends with a prompt, and no command anywhere in it')
const page = readFileSync(join(ROOT, 'console/connect.html'), 'utf8')
check(page.includes("from './agent-startup.mjs'"),
  'connect.html builds the handoff from the twin, not from a string it assembles itself')
check(!/node\s+tools\/connect-agent\.mjs/.test(page),
  'NO COMMAND — the page no longer renders `node tools/connect-agent.mjs` for the operator to run')
// Asserted as a property of the whole page, not of one function: the old text was in a template
// literal a rewrite could easily have left behind somewhere else on the page.
check(!/\bnode\s+tools\//.test(page), 'and no other `node tools/…` invocation survives on the page')
check(/id="handoff-copy"/.test(page), 'there is a copy button, since the operator has to move this text by hand')
// Found by mutation: everything above passed with the page still inheriting the default. Proving
// the OPTION exists is not proving the caller uses it, and the default names a command that did
// not write the paste.
check(/writtenBy:\s*'[^']*console/.test(page),
  'and the page NAMES ITSELF as the author rather than inheriting `connect-agent --startup`')

// The twin binding renders `startupDoc` against `startupDoc`, so it is blind to what the page HANDS
// it. `channel:` shipped reading `owner-key` — a 64-hex pubkey rendered under "Your channel", which
// `connect-agent --channel` refuses as a type and which contradicts the UUID the same agent has on
// disk. Nothing above could see it, because every assertion so far drives the renderer and none
// drives the call site.
const callSite = /startupDoc\(\{([\s\S]*?)\n\s*\}\)/.exec(page)
check(callSite, 'the handoff is built by a `startupDoc({…})` call this suite can read')
const argOf = field => new RegExp(`^\\s*${field}:.*$`, 'm').exec(callSite?.[1] || '')?.[0] || ''
check(/\$\('channel-id'\)/.test(argOf('channel')),
  '  …and `channel` is taken from the channel-id field, the one holding the UUID')
check(!/owner-key/.test(argOf('channel')),
  "  …and NOT from owner-key — the owner's pubkey is not this agent's channel")
// Positive control. Without it the two assertions above are satisfied by a page that reads
// `channel-id` into every field, which would be a different way to render the wrong document.
check(/\$\('agent-key'\)/.test(argOf('pubkey')) && !/channel-id/.test(argOf('pubkey')),
  "  …while `pubkey` still comes from agent-key, so the fields are not all reading one input")

// ------------------------------------------------------------------------------------------
console.log('\n7. the never-checked rows collapse, and the alarm stays variable')
// The console can observe one row and never the other eight, so it rendered eight identical
// never-checked lines and a "8 of these are not confirmed" alarm on EVERY connect — including a
// perfect install. A constant is not a signal; an alarm that always fires and one that never fires
// fail identically. Both directions are asserted below, because "collapse the rows" done wrong is
// indistinguishable from "stop reporting them".
const consoleShape = node.startupDoc({ agent: 'pi-agent', pubkey: PUB, report: { rows: rows({
  'bunker-uri': UNKNOWN, 'bunker-client': UNKNOWN, 'signer-identity': UNKNOWN, 'dm-relays': UNKNOWN,
  'admit-grant': PRESENT, 'mcp-registration': UNKNOWN, 'mcp-exclusive': UNKNOWN,
  'mcp-identity': UNKNOWN, profile: UNKNOWN }) } })
check(!/\*\*\d+ of these (is|are) not confirmed\.\*\*/.test(consoleShape),
  'the alarm does NOT fire when the only non-PRESENT rows are ones nothing looked at')
check(/8 further artifacts were never checked/.test(consoleShape),
  '  …and the eight are still reported, as one line that says never checked')
// Per-row bullets are what the eight lines were. The phrase itself legitimately appears once more
// in the invariant text, where a sentence renders one row's state inline — so count the BULLETS,
// not the phrase, or this assertion measures the wrong thing.
check(consoleShape.split('\n').filter(l => /^- .*never checked — do not assume either way\.?$/.test(l)).length === 0,
  '  …with no per-row never-checked bullet left behind')
check(consoleShape.split('\n').filter(l => /further artifacts? w(as|ere) never checked/.test(l)).length === 1,
  '  …and exactly one collapsed line, not one per row')
// SCOPED to the section being measured, for the same reason the line above counts bullets rather
// than the phrase. Counted across the whole document this fails the moment any other section
// legitimately names the same remedy — it did, when the lane commands were added (#512), and what it
// reported was a regression in the collapse that had not happened.
const beforeYouSpeak = (consoleShape.split('## Before you speak, know what is actually true')[1] || '').split('\n## ')[0]
check(beforeYouSpeak.trim().length > 0,
  '  …and the section being measured is actually present — an empty slice passes every filter below')
check((beforeYouSpeak.match(/connect-agent\.mjs [^`]*--check/g) || []).length === 1,
  '  …and the remedy once, not eight times')
// Nothing may be lost in the collapse: an agent has to be able to name what was not checked.
for (const k of ['bunker-uri', 'dm-relays', 'mcp-identity', 'profile']) {
  check(consoleShape.includes(k), `  …and still names ${k} by title, so the collapse loses no artifact`)
}
check(/admit-grant: confirmed/.test(consoleShape),
  '  …while the one row the console DID observe still renders in full')
check(!/Every artifact above is confirmed/.test(consoleShape),
  'and it never claims everything above is confirmed while a never-checked line sits above')

// POSITIVE CONTROL, the direction that matters most. Same shape, one row that was actually looked
// at and found MISSING: the alarm must fire. Without this the assertions above are satisfied by a
// document that has simply stopped warning about anything.
const realNegative = node.startupDoc({ agent: 'pi-agent', pubkey: PUB, report: { rows: rows({
  'bunker-uri': UNKNOWN, 'bunker-client': UNKNOWN, 'signer-identity': UNKNOWN, 'dm-relays': MISSING,
  'admit-grant': PRESENT, 'mcp-registration': UNKNOWN, 'mcp-exclusive': UNKNOWN,
  'mcp-identity': UNKNOWN, profile: UNKNOWN }) } })
check(/\*\*1 of these is not confirmed\.\*\*/.test(realNegative),
  'POSITIVE CONTROL — one row observed MISSING and the alarm fires, counting that row alone')
check(/7 further artifacts were never checked/.test(realNegative),
  '  …with the seven never-checked ones counted separately, not folded into the alarm')
check(realNegative.includes('nothing can reach you'),
  '  …and the dm-relays consequence is still spelled out where it applies')

// The size claim the change was made for, measured rather than asserted in prose. The block those
// eight rows occupy was ~1,100 bytes; the collapsed form is the two lines between the observed row
// and the blank line that follows. A ceiling here fails if someone re-expands it one row at a time.
const block = beforeYouSpeak.split('\n').filter(l => /never checked|connect-agent\.mjs [^`]*--check/.test(l)).join('\n')
check(block.length > 0 && block.length < 400,
  `NEVER-CHECKED BLOCK is ${block.length} bytes, down from ~1,100 — and non-empty, so this is measuring something`)

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
