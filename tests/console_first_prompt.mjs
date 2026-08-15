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
  ['no report at all — the "nothing here is confirmed" tail', {}],
  ['an empty rows array — the case that satisfies BOTH filters', { report: { rows: [] } }],
  ['no runtime label, no channel, no pubkey', { report: { rows: rows({ 'admit-grant': PRESENT }) } }],
]

for (const [what, extra] of MATRIX) {
  const args = {
    agent: 'Pi Agent', pubkey: PUB, channel: CHAN,
    runtimeLabel: 'Any other MCP host (Raspberry Pi, headless, self-hosted)', ...extra,
  }
  if (what.startsWith('no runtime label')) { delete args.runtimeLabel; delete args.channel; delete args.pubkey }
  const a = node.startupDoc(args), b = web.startupDoc(args)
  check(a === b, `${what} — the two copies render the same ${a.length} bytes`)
}

// A property the byte-comparison alone cannot state: that the comparison is comparing something.
// Two functions that both returned '' would pass every assertion above.
const sample = node.startupDoc({ agent: 'Pi Agent', pubkey: PUB, report: { rows: rows({ 'admit-grant': PRESENT }) } })
check(sample.length > 1500 && sample.includes('# Pi Agent — you are a participant'),
  `SIZE FLOOR — the rendered body is real (${sample.length} bytes, headed by the agent's name)`)
check(sample.includes('You do not get read'),
  'and carries the wall paragraph, the one claim an agent most often reports as a defect')

// The names differ between copies, so a stale twin cannot pass by echoing a constant.
const other = web.startupDoc({ agent: 'Second Agent', pubkey: 'b'.repeat(64), report: { rows: [] } })
check(other.includes('# Second Agent —') && !other.includes('Pi Agent'),
  'the twin renders the name it was given, not a baked-in one')

// ------------------------------------------------------------------------------------------
console.log('\n4. NEGATIVE CONTROL — a report carrying a credential refuses, identically')
// #490 asks for a control that FIRES. A `bunker://` reaches the document through a row NOTE, which
// is machine-generated text from a tool this file does not control — the exact path the sweep was
// put there to cover.
const poisoned = { agent: 'Pi Agent', pubkey: PUB, report: { rows: [
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
const rawKeyRow = { agent: 'Pi Agent', pubkey: PUB, report: { rows: [
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
const provenance = args => node.startupDoc({ agent: 'Pi Agent', report: { rows: [] }, ...args }).split('\n')[2]
check(provenance({}) === "Written by `tools/connect-agent.mjs --startup` from this agent's own install state.",
  'the DEFAULT is unchanged — the tool\'s output is byte-for-byte what it was before #490')
check(provenance({ writtenBy: 'the waggle console, at connect time,' })
    === "Written by the waggle console, at connect time, from this agent's own install state.",
  'and an override reads as a sentence, not as a slot with a command dropped into it')
check(provenance({ writtenBy: 'X' }) === web.startupDoc({ agent: 'Pi Agent', report: { rows: [] }, writtenBy: 'X' }).split('\n')[2],
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

console.log(`\n${pass} passed, ${fail} failed`)
assert.equal(fail, 0, `${fail} assertion(s) failed`)
